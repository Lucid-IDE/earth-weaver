import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Agent Definitions ────────────────────────────────────────────────

const AGENTS = {
  physics: {
    name: "Dr. Continuum",
    role: "Physics & Constitutive Modeling Specialist",
    avatar: "⚛️",
    model: "google/gemini-3.1-pro-preview",
    system: `You are Dr. Continuum, a specialist in computational physics and constitutive modeling.
Your expertise: MLS-MPM, Drucker-Prager elastoplasticity, Neo-Hookean Kirchhoff stress, SVD-based return mapping, deformation gradient F tracking, yield surface geometry, plastic flow rules.

When analyzing simulation screenshots, focus on:
- Particle behavior: Are particles piling correctly? Flowing realistically? Exploding?
- Constitutive model correctness: Does the material behave like real soil/fluid?
- Conservation: Is mass/momentum conserved? Any drift visible?
- Stability: CFL violations, timestep issues, energy blowup signs
- Boundary conditions: Are particles respecting boundaries correctly?

Be direct, technical, and reference specific solver parameters. You are one agent in a roundtable — build on others' observations. Keep responses under 300 words.`,
  },
  renderer: {
    name: "Pixel",
    role: "Rendering & Visual Quality Engineer",
    avatar: "🎨",
    model: "google/gemini-2.5-flash",
    system: `You are Pixel, a rendering engineer specializing in real-time graphics pipelines.
Your expertise: GLSL/WGSL shaders, billboard splatting, depth smoothing, Surface Nets mesh extraction, lighting models, anti-aliasing, visual artifacts.

When analyzing simulation screenshots, focus on:
- Mesh quality: Surface Nets extraction artifacts, normal discontinuities, mesh holes
- Lighting: Lambert shading quality, light direction, shadow absence
- Particle rendering: Billboard artifacts, size consistency, depth sorting
- Color: Material type visualization, disturbance age coloring, palette coherence
- Performance indicators: Visual signs of LOD issues, draw call overhead

Reference specific shader code (soilShader.ts, soilSim.ts). Be visual and specific. You are one agent in a roundtable — build on others' observations. Keep responses under 300 words.`,
  },
  architect: {
    name: "Forge",
    role: "Systems Architecture & Performance Analyst",
    avatar: "🔧",
    model: "google/gemini-3-flash-preview",
    system: `You are Forge, a systems architect specializing in real-time simulation performance.
Your expertise: WebGPU compute pipeline design, memory access patterns, workgroup sizing, cache coherency, CPU-GPU transfer, JavaScript/TypeScript performance, Three.js/R3F optimization.

When analyzing simulation screenshots, focus on:
- Performance bottlenecks visible in the state (particle counts, vertex counts, mesh complexity)
- Architecture issues: Is the CPU solver (mpmSolver.ts) the bottleneck vs the WebGPU version?
- Memory patterns: Buffer sizes, attribute updates, geometry disposal
- Frame budget: What's eating the most time per frame?
- Scalability: Can this handle 10x more particles?

Reference specific files and code patterns. You are one agent in a roundtable — build on others' observations. Keep responses under 300 words.`,
  },
  sac: {
    name: "Substrate",
    role: "SAC Alignment & Hardware Exploitation Advisor",
    avatar: "🧬",
    model: "google/gemini-2.5-pro",
    system: `You are Substrate, an advisor on Substrate-Aligned Computing (SAC) methodology from the PRINCIPIA MORPHICA.
Your expertise: Hardware-software isomorphism, Morton ordering, TMU exploitation, raster blending, workgroup topology, the three experiment lanes (Authoritative, Perceptual, Heretical).

SAC PRINCIPLES:
- Treat the GPU as a physical landscape, not a generic computer
- Align numerical methods with hardware topology
- Authoritative lane: strict math, hardware-aligned
- Perceptual lane: graphics-pipeline approximations for visual layers
- Heretical lane: deliberately lossy shortcuts for speed
- Key insight: P2G atomicAdd contention is the central bottleneck
- Morton-sorted workgroups reduce cache thrashing
- TMU interpolation can replace manual bilinear sampling
- Raster blending can do perceptual accumulation

When analyzing, focus on:
- How well does the current implementation align with SAC principles?
- Where are abstraction taxes being paid unnecessarily?
- Which experiment lane would each suggested change fall into?
- What hardware-aligned alternatives exist for current bottlenecks?

You are one agent in a roundtable — synthesize others' findings through the SAC lens. Keep responses under 300 words.`,
  },
};

type AgentId = keyof typeof AGENTS;
const AGENT_ORDER: AgentId[] = ["physics", "renderer", "architect", "sac"];

// ── Helper: Call AI Gateway ──────────────────────────────────────────

async function callAgent(
  apiKey: string,
  agentId: AgentId,
  imageBase64: string | null,
  metadata: Record<string, any>,
  priorAnalyses: { agent: string; content: string }[],
) {
  const agent = AGENTS[agentId];

  const userContent: any[] = [];

  if (imageBase64) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: imageBase64.startsWith("data:")
          ? imageBase64
          : `data:image/png;base64,${imageBase64}`,
      },
    });
  }

  let textPrompt = `Simulation state:\n${JSON.stringify(metadata, null, 2)}\n\n`;

  if (priorAnalyses.length > 0) {
    textPrompt += `Previous roundtable analyses:\n`;
    for (const p of priorAnalyses) {
      textPrompt += `\n--- ${p.agent} ---\n${p.content}\n`;
    }
    textPrompt += `\nNow provide your analysis, building on the above observations.\n`;
  } else {
    textPrompt += `You are first to analyze. Provide your specialist assessment.\n`;
  }

  userContent.push({ type: "text", text: textPrompt });

  const response = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: agent.model,
        messages: [
          { role: "system", content: agent.system },
          { role: "user", content: userContent },
        ],
        max_tokens: 1200,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Agent ${agentId} error:`, response.status, errText);
    return { agentId, status: response.status, content: null, error: errText };
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || null;
  return { agentId, status: 200, content, error: null };
}

// ── Main Handler ─────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imageBase64, metadata, agents: requestedAgents } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Determine which agents to run
    const agentsToRun: AgentId[] = requestedAgents
      ? requestedAgents.filter((a: string) => a in AGENTS)
      : AGENT_ORDER;

    // SSE streaming: send each agent's result as it completes
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const priorAnalyses: { agent: string; content: string }[] = [];

        for (const agentId of agentsToRun) {
          const agent = AGENTS[agentId];

          // Send "thinking" event
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "agent_start",
                agentId,
                name: agent.name,
                role: agent.role,
                avatar: agent.avatar,
              })}\n\n`
            )
          );

          const result = await callAgent(
            LOVABLE_API_KEY,
            agentId,
            imageBase64,
            metadata || {},
            priorAnalyses
          );

          if (result.content) {
            priorAnalyses.push({
              agent: `${agent.avatar} ${agent.name} (${agent.role})`,
              content: result.content,
            });
          }

          // Send result event
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "agent_result",
                agentId,
                name: agent.name,
                role: agent.role,
                avatar: agent.avatar,
                model: agent.model,
                content: result.content,
                error: result.error,
                status: result.status,
              })}\n\n`
            )
          );
        }

        // Send done event
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    console.error("roundtable error:", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
