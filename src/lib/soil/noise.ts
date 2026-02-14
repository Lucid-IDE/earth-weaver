function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 48611)) | 0;
  h = ((h >> 13) ^ h) | 0;
  h = (h * ((h * h * 15731 + 789221) | 0) + 1376312589) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

export function noise3D(x: number, y: number, z: number, seed: number = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fade(fx);
  const sy = fade(fy);
  const sz = fade(fz);

  const n000 = hash3(ix, iy, iz, seed);
  const n100 = hash3(ix + 1, iy, iz, seed);
  const n010 = hash3(ix, iy + 1, iz, seed);
  const n110 = hash3(ix + 1, iy + 1, iz, seed);
  const n001 = hash3(ix, iy, iz + 1, seed);
  const n101 = hash3(ix + 1, iy, iz + 1, seed);
  const n011 = hash3(ix, iy + 1, iz + 1, seed);
  const n111 = hash3(ix + 1, iy + 1, iz + 1, seed);

  return lerp(
    lerp(lerp(n000, n100, sx), lerp(n010, n110, sx), sy),
    lerp(lerp(n001, n101, sx), lerp(n011, n111, sx), sy),
    sz
  ) * 2 - 1;
}

export function fbm3D(x: number, y: number, z: number, octaves: number = 4, seed: number = 0): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += noise3D(x * frequency, y * frequency, z * frequency, seed + i * 31) * amplitude;
    maxAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maxAmp;
}
