// Thin WebGL helper layer: context creation, program compile + introspection, buffers.

// Interleaved vertex format shared by all lit geometry (11 floats / 44 bytes).
export const LIT_LAYOUT = [
  ['a_pos', 3],
  ['a_nrm', 3],
  ['a_col', 3],
  ['a_ao', 1],
  ['a_sway', 1],
];
export const LIT_STRIDE = 11;

export function createGL(canvas) {
  const opts = {
    alpha: false,
    antialias: false, // anti-aliasing is done by the FXAA pass in the post chain
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  } catch (e) {
    gl = null;
  }
  if (!gl) throw new Error('WebGL is not available in this browser.');
  return gl;
}

function compileShader(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || 'unknown error';
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3, ' ')}| ${l}`)
      .join('\n');
    gl.deleteShader(sh);
    throw new Error(`Shader compile error in ${label}:\n${log}\n${numbered}`);
  }
  return sh;
}

export function createProgram(gl, vsSrc, fsSrc, name) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${name} (vertex)`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${name} (fragment)`);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || 'unknown error';
    throw new Error(`Program link error in ${name}:\n${log}`);
  }
  const u = {};
  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const key = info.name.replace(/\[0\]$/, '');
    u[key] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
  }
  const a = {};
  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(prog, i);
    if (!info) continue;
    a[info.name] = gl.getAttribLocation(prog, info.name);
  }
  return { prog, u, a, name };
}

export function useProgram(gl, p) {
  gl.useProgram(p.prog);
  for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i);
}

// Sets any uniforms in `values` that the program actually has (others are ignored).
export function setUniforms(gl, p, values) {
  for (const k in values) {
    const u = p.u[k];
    if (!u || u.loc === null) continue;
    const v = values[k];
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1) gl.uniform1fv(u.loc, v);
        else gl.uniform1f(u.loc, v);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
      case gl.INT:
      case gl.BOOL:
      case gl.SAMPLER_2D:
        gl.uniform1i(u.loc, v);
        break;
      default: break;
    }
  }
}

export function createBuffer(gl, data, target, usage) {
  const buf = gl.createBuffer();
  const t = target || gl.ARRAY_BUFFER;
  gl.bindBuffer(t, buf);
  gl.bufferData(t, data, usage || gl.STATIC_DRAW);
  return buf;
}

// Binds an interleaved vertex buffer to the attributes the program uses.
export function bindLayout(gl, p, vbo, layout) {
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  let stride = 0;
  for (const item of layout) stride += item[1];
  stride *= 4;
  let off = 0;
  for (const item of layout) {
    const loc = p.a[item[0]];
    if (loc !== undefined && loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, item[1], gl.FLOAT, false, stride, off);
    }
    off += item[1] * 4;
  }
}
