import { decomposeScene } from './decomposeScene';
import { makeFramebuffer } from './Framebuffer';
import { makeFullscreenQuad } from './FullscreenQuad';
import { makeGBufferPass } from './GBufferPass';
import { makeMaterialBuffer } from './MaterialBuffer';
import { mergeMeshesToGeometry } from './mergeMeshesToGeometry';
import { makeRayTracePass } from './RayTracePass';
import { makeRenderSize } from './RenderSize';
import { makeReprojectPass } from './ReprojectPass';
import { makeToneMapPass } from './ToneMapPass';
import { clamp, numberArraysEqual } from './util';
import { makeTileRender } from './TileRender';
import { makeDepthTarget, makeTexture } from './Texture';
import noiseBase64 from './texture/noise';
import { PerspectiveCamera, Vector2 } from 'three';

function areCamerasEqual(cam1, cam2) {
  return numberArraysEqual(cam1.matrixWorld.elements, cam2.matrixWorld.elements) &&
    cam1.aspect === cam2.aspect &&
    cam1.fov === cam2.fov;
}

class RenderingPipeline {
  constructor(gl, scene, toneMappingParams, optionalExtensions, bounces) {
    this.gl = gl;
    
    this.maxReprojectedSamples = 20;

    // how many samples to render with uniform noise before switching to stratified noise
    this.numUniformSamples = 4;

    // how many partitions of stratified noise should be created
    // higher number results in faster convergence over time, but with lower quality initial samples
    this.strataCount = 6;

    // tile rendering can cause the GPU to stutter, throwing off future benchmarks for the preview frames
    // wait to measure performance until this number of frames have been rendered
    this.previewFramesBeforeBenchmark = 2;

    // used to sample only a portion of the scene to the HDR Buffer to prevent the GPU from locking up from excessive computation
    this.tileRender = makeTileRender(gl);

    this.previewSize = makeRenderSize(gl);

    const decomposedScene = decomposeScene(scene);

    const mergedMesh = mergeMeshesToGeometry(decomposedScene.meshes);

    const materialBuffer = makeMaterialBuffer(gl, mergedMesh.materials);

    const fullscreenQuad = makeFullscreenQuad(gl);

    this.rayTracePass = makeRayTracePass(gl, { bounces, decomposedScene, fullscreenQuad, materialBuffer, mergedMesh, optionalExtensions, scene });

    this.reprojectPass = makeReprojectPass(gl, { fullscreenQuad, maxReprojectedSamples: this.maxReprojectedSamples });

    this.toneMapPass = makeToneMapPass(gl, { fullscreenQuad, toneMappingParams });

    this.gBufferPass = makeGBufferPass(gl, { materialBuffer, mergedMesh });

    this.ready = false;

    const noiseImage = new Image();
    noiseImage.src = noiseBase64;
    noiseImage.onload = () => {
      this.rayTracePass.setNoise(noiseImage);
      this.ready = true;
    };

    this.frameTime = null;
    this.elapsedFrameTime = null;
    this.sampleTime = null;

    this.sampleCount = 0;
    this.numPreviewsRendered = 0;

    this.firstFrame = true;

    this.sampleRenderedCallback = () => {};

    this.lastCamera = new PerspectiveCamera();
    this.lastCamera.position.set(1, 1, 1);
    this.lastCamera.updateMatrixWorld();

    this.screenWidth = 0;
    this.screenHeight = 0;

    this.fullscreenScale = new Vector2(1, 1);

    this.lastToneMappedScale = this.fullscreenScale;

    this.hdrBuffer = null;
    this.hdrBackBuffer = null;
    this.reprojectBuffer = null;
    this.reprojectBackBuffer = null;

    this.gBuffer = null;
    this.gBufferBack = null;

    this.lastToneMappedTexture = null;
  }

  initFrameBuffers(width, height) {
    const gl = this.gl;
    
    const gBufferOutputLocs = this.gBufferPass.outputLocs;
    
    const makeBuffer = () => makeFramebuffer(gl, {
      color: { 0: makeTexture(gl, { width, height, storage: 'float', magFilter: gl.LINEAR, minFilter: gl.LINEAR }) }
    });

    this.hdrBuffer = makeBuffer();
    this.hdrBackBuffer = makeBuffer();

    this.reprojectBuffer = makeBuffer();
    this.reprojectBackBuffer = makeBuffer();

    const normalBuffer = makeTexture(gl, { width, height, storage: 'halfFloat' });
    const faceNormalBuffer = makeTexture(gl, { width, height, storage: 'halfFloat' });
    const colorBuffer = makeTexture(gl, { width, height, storage: 'byte', channels: 3 });
    const matProps = makeTexture(gl, { width, height, storage: 'byte', channels: 2 });
    const depthTarget = makeDepthTarget(gl, width, height);

    const makeGBuffer = () => makeFramebuffer(gl, {
      color: {
        [gBufferOutputLocs.position]: makeTexture(gl, { width, height, storage: 'float' }),
        [gBufferOutputLocs.normal]: normalBuffer,
        [gBufferOutputLocs.faceNormal]: faceNormalBuffer,
        [gBufferOutputLocs.color]: colorBuffer,
        [gBufferOutputLocs.matProps]: matProps,
      },
      depth: depthTarget
    });

    this.gBuffer = makeGBuffer();
    this.gBufferBack = makeGBuffer();

    this.lastToneMappedTexture = this.hdrBuffer.color[this.rayTracePass.outputLocs.light];
  }

  swapReprojectBuffer() {
    let temp = this.reprojectBuffer;
    this.reprojectBuffer = this.reprojectBackBuffer;
    this.reprojectBackBuffer = temp;
  }

  swapGBuffer() {
    let temp = this.gBuffer;
    this.gBuffer = this.gBufferBack;
    this.gBufferBack = temp;
  }

  swapHdrBuffer() {
    let temp = this.hdrBuffer;
    this.hdrBuffer = this.hdrBackBuffer;
    this.hdrBackBuffer = temp;
  }

  // Shaders will read from the back buffer and draw to the front buffer
  // Buffers are swapped after every render
  swapBuffers() {
    this.swapReprojectBuffer();
    this.swapGBuffer();
    this.swapHdrBuffer();
  }

  setSize(w, h) {
    this.screenWidth = w;
    this.screenHeight = h;

    this.tileRender.setSize(w, h);
    this.previewSize.setSize(w, h);
    this.initFrameBuffers(w, h);
    this.firstFrame = true;
  }

  // called every frame to update clock
  time(newTime) {
    this.elapsedFrameTime = newTime - this.frameTime;
    this.frameTime = newTime;
  }

  updateSeed(width, height, useJitter = true) {
    this.rayTracePass.setSize(width, height);

    const jitterX = useJitter ? (Math.random() - 0.5) / width : 0;
    const jitterY = useJitter ? (Math.random() - 0.5) / height : 0;
    this.gBufferPass.setJitter(jitterX, jitterY);
    this.rayTracePass.setJitter(jitterX, jitterY);
    this.reprojectPass.setJitter(jitterX, jitterY);

    if (this.sampleCount === 0) {
      this.rayTracePass.setStrataCount(1);
    } else if (this.sampleCount === this.numUniformSamples) {
      this.rayTracePass.setStrataCount(this.strataCount);
    } else {
      this.rayTracePass.nextSeed();
    }
  }

  clearBuffer(buffer) {
    buffer.bind();
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    buffer.unbind();
  }

  addSampleToBuffer(buffer, width, height) {
    const gl = this.gl;
    
    buffer.bind();

    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    gl.viewport(0, 0, width, height);
    this.rayTracePass.draw();

    gl.disable(gl.BLEND);
    buffer.unbind();
  }

  newSampleToBuffer(buffer, width, height) {
    buffer.bind();
    this.gl.viewport(0, 0, width, height);
    this.rayTracePass.draw();
    buffer.unbind();
  }

  toneMapToScreen(lightTexture, lightScale) {
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
    this.toneMapPass.draw({
      light: lightTexture,
      lightScale,
      position: this.gBuffer.color[this.gBufferPass.outputLocs.position],
    });

    this.lastToneMappedTexture = lightTexture;
    this.lastToneMappedScale = lightScale.clone();
  }

  renderGBuffer() {
    const gBufferColor = this.gBuffer.color;
    
    const gBufferOutputLocs = this.gBufferPass.outputLocs;
    
    this.gBuffer.bind();
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    this.gl.viewport(0, 0, this.screenWidth, this.screenHeight);
    this.gBufferPass.draw();
    this.gBuffer.unbind();

    this.rayTracePass.setGBuffers({
      position: gBufferColor[gBufferOutputLocs.position],
      normal: gBufferColor[gBufferOutputLocs.normal],
      faceNormal: gBufferColor[gBufferOutputLocs.faceNormal],
      color: gBufferColor[gBufferOutputLocs.color],
      matProps: gBufferColor[gBufferOutputLocs.matProps]
    });
  }

  renderTile(buffer, x, y, width, height) {
    this.gl.scissor(x, y, width, height);
    this.gl.enable(this.gl.SCISSOR_TEST);
    this.addSampleToBuffer(buffer, this.screenWidth, this.screenHeight);
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  setCameras(camera, lastCamera) {
    this.rayTracePass.setCamera(camera);
    this.gBufferPass.setCamera(camera);
    this.reprojectPass.setPreviousCamera(lastCamera);
    lastCamera.copy(camera);
  }

  drawPreview() {
    if (this.sampleCount > 0) {
      this.swapBuffers();
    }

    if (this.numPreviewsRendered >= this.previewFramesBeforeBenchmark) {
      this.previewSize.adjustSize(this.elapsedFrameTime);
    }

    this.updateSeed(this.previewSize.width, this.previewSize.height, false);

    this.renderGBuffer();

    this.rayTracePass.bindTextures();
    this.newSampleToBuffer(this.hdrBuffer, this.previewSize.width, this.previewSize.height);

    this.reprojectBuffer.bind();
    this.gl.viewport(0, 0, this.previewSize.width, this.previewSize.height);
    this.reprojectPass.draw({
      blendAmount: 1.0,
      light: this.hdrBuffer.color[0],
      lightScale: this.previewSize.scale,
      position: this.gBuffer.color[this.gBufferPass.outputLocs.position],
      previousLight: this.lastToneMappedTexture,
      previousLightScale: this.lastToneMappedScale,
      previousPosition: this.gBufferBack.color[this.gBufferPass.outputLocs.position],
    });
    this.reprojectBuffer.unbind();

    this.toneMapToScreen(this.reprojectBuffer.color[0], this.previewSize.scale);

    this.swapBuffers();
  }

  drawTile() {
    const { x, y, tileWidth, tileHeight, isFirstTile, isLastTile } = this.tileRender.nextTile(this.elapsedFrameTime);

    if (isFirstTile) {
      if (this.sampleCount === 0) { // previous rendered image was a preview image
        this.clearBuffer(this.hdrBuffer);
        this.reprojectPass.setPreviousCamera(this.lastCamera);
      } else {
        this.sampleRenderedCallback(this.sampleCount, this.frameTime - this.sampleTime || NaN);
        this.sampleTime = this.frameTime;
      }

      this.updateSeed(this.screenWidth, this.screenHeight, true);
      this.renderGBuffer();
      this.rayTracePass.bindTextures();
    }

    this.renderTile(this.hdrBuffer, x, y, tileWidth, tileHeight);

    if (isLastTile) {
      this.sampleCount++;

      let blendAmount = clamp(1.0 - this.sampleCount / this.maxReprojectedSamples, 0, 1);
      blendAmount *= blendAmount;

      if (blendAmount > 0.0) {
        this.reprojectBuffer.bind();
        this.gl.viewport(0, 0, this.screenWidth, this.screenHeight);
        this.reprojectPass.draw({
          blendAmount,
          light: this.hdrBuffer.color[0],
          lightScale: this.fullscreenScale,
          position: this.gBuffer.color[this.gBufferPass.outputLocs.position],
          previousLight: this.reprojectBackBuffer.color[0],
          previousLightScale: this.previewSize.scale,
          previousPosition: this.gBufferBack.color[this.gBufferPass.outputLocs.position],
        });
        this.reprojectBuffer.unbind();

        this.toneMapToScreen(this.reprojectBuffer.color[0], this.fullscreenScale);
      } else {
        this.toneMapToScreen(this.hdrBuffer.color[0], this.fullscreenScale);
      }
    }
  }

  draw(camera) {
    if (!this.ready) {
      return;
    }

    if (!areCamerasEqual(camera, this.lastCamera)) {
      this.setCameras(camera, this.lastCamera);

      if (this.firstFrame) {
        this.firstFrame = false;
      } else {
        this.drawPreview(camera, this.lastCamera);
        this.numPreviewsRendered++;
      }
      this.tileRender.reset();
      this.sampleCount = 0;
    } else {
      this.drawTile();
      this.numPreviewsRendered = 0;
    }
  }

  // debug draw call to measure performance
  // use full resolution buffers every frame
  // reproject every frame
  drawFull(camera) {
    if (!this.ready) {
      return;
    }

    this.swapGBuffer();
    this.swapReprojectBuffer();

    if (!areCamerasEqual(camera, this.lastCamera)) {
      this.sampleCount = 0;
      this.clearBuffer(this.hdrBuffer);
    } else {
      this.sampleCount++;
    }

    this.setCameras(camera, this.lastCamera);

    this.updateSeed(this.screenWidth, this.screenHeight, true);

    this.renderGBuffer(camera);

    this.rayTracePass.bindTextures();
    this.addSampleToBuffer(this.hdrBuffer, this.screenWidth, this.screenHeight);

    this.reprojectBuffer.bind();
    this.gl.viewport(0, 0, this.screenWidth, this.screenHeight);
    this.reprojectPass.draw({
      blendAmount: 1.0,
      light: this.hdrBuffer.color[0],
      lightScale: this.fullscreenScale,
      position: this.gBuffer.color[this.gBufferPass.outputLocs.position],
      previousLight: this.lastToneMappedTexture,
      previousLightScale: this.lastToneMappedScale,
      previousPosition: this.gBufferBack.color[this.gBufferPass.outputLocs.position],
    });
    this.reprojectBuffer.unbind();

    this.toneMapToScreen(this.reprojectBuffer.color[0], this.fullscreenScale);
  }
}

export function makeRenderingPipeline({
    gl,
    scene,
    toneMappingParams,
    optionalExtensions,
    bounces, // number of global illumination bounces
  }) {
  
  const renderingPipeline = new RenderingPipeline(gl, scene, toneMappingParams, optionalExtensions, bounces);

  return {
    draw: renderingPipeline.draw.bind(renderingPipeline),
    drawFull: renderingPipeline.drawFull.bind(renderingPipeline),
    setSize: renderingPipeline.setSize.bind(renderingPipeline),
    time: renderingPipeline.time.bind(renderingPipeline),
    getTotalSamplesRendered() {
      return renderingPipeline.sampleCount;
    },
    set onSampleRendered(cb) {
      renderingPipeline.sampleRenderedCallback = cb;
    },
    get onSampleRendered() {
      return renderingPipeline.sampleRenderedCallback;
    }
  };
}
