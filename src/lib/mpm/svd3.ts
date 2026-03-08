// ── 3×3 SVD via Jacobi rotations ─────────────────────────────────────
// Computes A = U * Σ * Vᵀ for 3×3 matrices stored as flat 9-element arrays.
// Used for Drucker-Prager return mapping on the deformation gradient.

type Mat3 = [number, number, number, number, number, number, number, number, number];

function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0]*b[0]+a[1]*b[3]+a[2]*b[6], a[0]*b[1]+a[1]*b[4]+a[2]*b[7], a[0]*b[2]+a[1]*b[5]+a[2]*b[8],
    a[3]*b[0]+a[4]*b[3]+a[5]*b[6], a[3]*b[1]+a[4]*b[4]+a[5]*b[7], a[3]*b[2]+a[4]*b[5]+a[5]*b[8],
    a[6]*b[0]+a[7]*b[3]+a[8]*b[6], a[6]*b[1]+a[7]*b[4]+a[8]*b[7], a[6]*b[2]+a[7]*b[5]+a[8]*b[8],
  ];
}

function mat3T(a: Mat3): Mat3 {
  return [a[0],a[3],a[6], a[1],a[4],a[7], a[2],a[5],a[8]];
}

const IDENTITY: Mat3 = [1,0,0, 0,1,0, 0,0,1];

// Jacobi rotation to zero out off-diagonal element (p,q)
function jacobiRotation(S: Mat3, p: number, q: number): { G: Mat3; Gt: Mat3 } {
  const Spq = S[p * 3 + q];
  if (Math.abs(Spq) < 1e-15) {
    return { G: [...IDENTITY] as Mat3, Gt: [...IDENTITY] as Mat3 };
  }

  const Spp = S[p * 3 + p];
  const Sqq = S[q * 3 + q];
  const tau = (Sqq - Spp) / (2 * Spq);
  const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
  const c = 1 / Math.sqrt(1 + t * t);
  const s = t * c;

  const G: Mat3 = [...IDENTITY] as Mat3;
  G[p * 3 + p] = c;
  G[q * 3 + q] = c;
  G[p * 3 + q] = s;
  G[q * 3 + p] = -s;

  const Gt: Mat3 = [...IDENTITY] as Mat3;
  Gt[p * 3 + p] = c;
  Gt[q * 3 + q] = c;
  Gt[p * 3 + q] = -s;
  Gt[q * 3 + p] = s;

  return { G, Gt };
}

export interface SVDResult {
  U: Mat3;
  sigma: [number, number, number];
  V: Mat3;
}

export function svd3x3(F: Mat3): SVDResult {
  // Compute F^T F
  let S = mat3Mul(mat3T(F), F);
  let V: Mat3 = [...IDENTITY] as Mat3;

  // Jacobi eigenvalue iterations on S = F^T F
  for (let iter = 0; iter < 12; iter++) {
    for (const [p, q] of [[0,1],[0,2],[1,2]] as [number,number][]) {
      const { G, Gt } = jacobiRotation(S, p, q);
      S = mat3Mul(mat3Mul(Gt, S), G);
      V = mat3Mul(V, G);
    }
  }

  // Singular values from diagonal of S (which is now Σ²)
  const sig0 = Math.sqrt(Math.max(0, S[0]));
  const sig1 = Math.sqrt(Math.max(0, S[4]));
  const sig2 = Math.sqrt(Math.max(0, S[8]));
  const sigma: [number, number, number] = [sig0, sig1, sig2];

  // U = F V Σ^{-1}
  const FV = mat3Mul(F, V);
  const U: Mat3 = [...IDENTITY] as Mat3;
  for (let col = 0; col < 3; col++) {
    const s = sigma[col];
    if (s > 1e-10) {
      U[0 * 3 + col] = FV[0 * 3 + col] / s;
      U[1 * 3 + col] = FV[1 * 3 + col] / s;
      U[2 * 3 + col] = FV[2 * 3 + col] / s;
    } else {
      U[0 * 3 + col] = col === 0 ? 1 : 0;
      U[1 * 3 + col] = col === 1 ? 1 : 0;
      U[2 * 3 + col] = col === 2 ? 1 : 0;
    }
  }

  return { U, sigma, V };
}

// Reconstruct F from U, sigma, V: F = U * diag(sigma) * V^T
export function svdRecompose(U: Mat3, sigma: [number, number, number], V: Mat3): Mat3 {
  const S: Mat3 = [sigma[0],0,0, 0,sigma[1],0, 0,0,sigma[2]];
  return mat3Mul(mat3Mul(U, S), mat3T(V));
}
