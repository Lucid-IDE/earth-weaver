// ── AI Diagnostic Edge Function ─────────────────────────────────────
// Receives the latest telemetry frame, ~3s of history, and self-test
// results. Returns a focused root-cause analysis from Lovable AI.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are an expert real-time simulation diagnostician for a heavy-equipment soil simulator.
You see a single telemetry "frame" snapshot, a short history (~3s), and the latest automated self-test results.

For each FAILED test, identify the most likely root cause by cross-referencing:
- Input layer: were keys actually registered? (check input.exc / input.doz values during the test window)
- Drivetrain: did engine RPM rise, did torque flow, did track velocity respond?
- Kinematics: did the joint angle change?
- Physics constraints: stalled engine, lugging, low hydraulic pressure, or saturated slip?
- Render: low FPS could starve the physics step.

Be concise. Use this format:
## Summary
1-2 sentences on overall health.

## Failures
For each failed test: **<test name>** — <root cause hypothesis>. <one-line fix suggestion>.

## Healthy systems
Bullet list of subsystems confirmed working.

## Recommended next action
One concrete next step.`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { frame, history, tests } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Trim history to keep token count reasonable
    const trimmedHistory = (history ?? []).map((f: any) => ({
      t: +f.t.toFixed(2),
      active: f.active,
      excFwd: +f.exc.forwardVel.toFixed(4),
      excAng: +f.exc.angularVel.toFixed(4),
      excLT: +f.exc.leftTrackVel.toFixed(4),
      excRT: +f.exc.rightTrackVel.toFixed(4),
      excRpm: Math.round(f.exc.rpm),
      excThr: +f.exc.throttle.toFixed(2),
      excHydP: +f.exc.hydPressure.toFixed(2),
      dozFwd: +f.doz.forwardVel.toFixed(4),
      bladeH: +f.joints.bladeHeight.toFixed(4),
      boom: +f.joints.boom.toFixed(3),
      stick: +f.joints.stick.toFixed(3),
      bucket: +f.joints.bucket.toFixed(3),
      fps: +f.render.fps.toFixed(1),
    }));

    const userContent = `LATEST FRAME:\n${JSON.stringify(frame, null, 2)}\n\nHISTORY (compressed, last ~3s):\n${JSON.stringify(trimmedHistory)}\n\nTEST RESULTS:\n${JSON.stringify(tests, null, 2)}`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (resp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add funds in Settings → Workspace → Usage." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await resp.text();
      console.error("AI gateway error", resp.status, t);
      return new Response(JSON.stringify({ error: `AI gateway ${resp.status}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    const analysis = data.choices?.[0]?.message?.content ?? "(no content)";

    return new Response(JSON.stringify({ analysis }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("diagnose error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
