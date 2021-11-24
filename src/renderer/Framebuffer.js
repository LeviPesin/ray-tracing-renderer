function bindFramebuffer() {
  this.gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
}

function unbindFramebuffer() {
  this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
}

export function makeFramebuffer(gl, { color, depth }) {
  const framebuffer = gl.createFramebuffer();
  
  const thisFramebuffer = {gl, framebuffer};
  
  const bind   = bindFramebuffer  .bind(thisFramebuffer);
  const unbind = unbindFramebuffer.bind(thisFramebuffer);

  bind();

  const drawBuffers = [];

  for (let location in color) {
    location = Number(location);

    if (Number.isNaN(location)) {
      console.error('invalid location');
    }

    const tex = color[location];
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + location, tex.target, tex.texture, 0);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + location);
  }

  gl.drawBuffers(drawBuffers);

  if (depth) {
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depth.target, depth.texture);
  }

  unbind();

  return {
    color,
    bind,
    unbind
  };
}
