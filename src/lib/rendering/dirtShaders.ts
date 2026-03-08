// ── Dirt Splat Shaders ───────────────────────────────────────────────
// Large camera-facing quads with soft radial falloff that overlap
// to form a cohesive dirt/soil mass. Each splat has:
//   - Billboard orientation (always faces camera)
//   - Soft circular alpha with procedural noise for irregular edges
//   - Per-instance color, scale, and rotation variation
//   - Depth-aware rendering for proper occlusion

export const dirtSplatVertexShader = /* glsl */ `
  attribute vec3 instancePosition;
  attribute vec4 instanceColor;
  attribute float instanceScale;
  attribute float instanceRotation;
  attribute float instanceNoisePhase;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vNoisePhase;
  varying float vDepth;
  varying vec3 vWorldPos;
  varying vec3 vViewNormal;

  void main() {
    vUv = uv;
    vColor = instanceColor.rgb;
    vNoisePhase = instanceNoisePhase;

    // Billboard: construct camera-facing quad
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    // Apply per-instance rotation around view axis
    float c = cos(instanceRotation);
    float s = sin(instanceRotation);
    vec3 rotRight = cameraRight * c + cameraUp * s;
    vec3 rotUp = -cameraRight * s + cameraUp * c;

    // Scale the quad — large enough to overlap neighbors
    float size = instanceScale;
    vec3 vertexPos = instancePosition
      + rotRight * position.x * size
      + rotUp * position.y * size;

    vWorldPos = vertexPos;
    
    vec4 mvPos = modelViewMatrix * vec4(vertexPos, 1.0);
    vDepth = -mvPos.z;
    vViewNormal = normalize(vec3(0.0, 0.0, 1.0)); // facing camera
    
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const dirtSplatFragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vNoisePhase;
  varying float vDepth;
  varying vec3 vWorldPos;
  varying vec3 vViewNormal;

  // Simple hash noise
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // FBM noise for irregular edges
  float fbm(vec2 p) {
    float v = 0.0;
    v += 0.5 * noise2D(p * 1.0);
    v += 0.25 * noise2D(p * 2.0);
    v += 0.125 * noise2D(p * 4.0);
    return v;
  }

  void main() {
    // Distance from center of splat
    vec2 centered = vUv * 2.0 - 1.0;
    float dist = length(centered);
    
    // Soft circular falloff with noisy edges
    float noiseVal = fbm(centered * 3.0 + vNoisePhase * 10.0);
    float edgeNoise = noiseVal * 0.35;
    
    // Base alpha: soft circle with irregular boundary
    float alpha = 1.0 - smoothstep(0.3, 0.85 + edgeNoise, dist);
    
    // Kill pixels outside the splat
    if (alpha < 0.01) discard;
    
    // Surface detail: subtle bumps and cracks
    float detail = fbm(centered * 8.0 + vNoisePhase * 5.0);
    float cracks = smoothstep(0.48, 0.52, noise2D(centered * 12.0 + vNoisePhase * 3.0));
    
    // Lighting: hemisphere light approximation
    // Fake normal from noise for surface variation
    float nx = (noise2D((centered + vec2(0.01, 0.0)) * 6.0 + vNoisePhase) - noise2D((centered - vec2(0.01, 0.0)) * 6.0 + vNoisePhase)) * 2.0;
    float ny = (noise2D((centered + vec2(0.0, 0.01)) * 6.0 + vNoisePhase) - noise2D((centered - vec2(0.0, 0.01)) * 6.0 + vNoisePhase)) * 2.0;
    vec3 fakeNormal = normalize(vec3(nx, ny, 1.0));
    
    vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
    float diffuse = max(dot(fakeNormal, lightDir), 0.0);
    float ambient = 0.45;
    
    // Darken in crevices (center-based AO approximation)
    float ao = mix(0.7, 1.0, smoothstep(0.0, 0.5, dist));
    
    // Apply color with variation
    vec3 color = vColor;
    color *= (ambient + diffuse * 0.55) * ao;
    color *= 0.85 + detail * 0.3; // surface detail
    color *= 0.9 + cracks * 0.1; // crack highlights
    
    // Slight darkening at edges (subsurface scattering fake)
    color *= mix(0.85, 1.0, 1.0 - dist * 0.3);
    
    gl_FragColor = vec4(color, alpha * 0.92);
  }
`;

// ── Dust Particle Shaders ────────────────────────────────────────────
export const dustVertexShader = /* glsl */ `
  attribute vec3 instancePosition;
  attribute float instanceAlpha;
  attribute float instanceScale;

  varying vec2 vUv;
  varying float vAlpha;

  void main() {
    vUv = uv;
    vAlpha = instanceAlpha;

    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    float size = instanceScale;
    vec3 vertexPos = instancePosition
      + cameraRight * position.x * size
      + cameraUp * position.y * size;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(vertexPos, 1.0);
  }
`;

export const dustFragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;

  void main() {
    vec2 centered = vUv * 2.0 - 1.0;
    float dist = length(centered);
    float alpha = (1.0 - smoothstep(0.0, 1.0, dist)) * vAlpha;
    if (alpha < 0.01) discard;
    
    vec3 dustColor = vec3(0.65, 0.55, 0.40);
    gl_FragColor = vec4(dustColor, alpha * 0.4);
  }
`;
