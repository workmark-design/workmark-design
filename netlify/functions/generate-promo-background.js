// netlify/functions/generate-promo-background.js
//
// NOTE the "-background" suffix: regular Netlify functions time out at 10s,
// which is far too short for video generation. Background functions run up to
// 15 min. You invoke it the same way (POST /.netlify/functions/generate-promo-background)
// but it returns 202 immediately and finishes async — so persist the result
// (see Supabase write below) rather than relying on the HTTP response.
//
// Required env vars (Netlify dashboard → Site settings → Environment):
//   HF_CREDENTIALS        = "KEY_ID:KEY_SECRET"   (from Higgsfield Cloud)
//   ANTHROPIC_API_KEY     = "sk-ant-..."
//   SUPABASE_URL          = "https://xxxx.supabase.co"
//   SUPABASE_SERVICE_KEY  = service-role key (server-side only, never ship to client)
//
// Install: npm install @higgsfield/client

import { higgsfield, config } from '@higgsfield/client/v2';

// Higgsfield v2 is SERVER-SIDE ONLY (browser usage is blocked), which is exactly
// why this lives in a function and not in your tablet-built front-end.
config({ credentials: process.env.HF_CREDENTIALS });

// ---------------------------------------------------------------------------
// 1) Claude turns raw business data into a structured Higgsfield brief.
//    We force JSON-only output so we can feed it straight into Higgsfield.
// ---------------------------------------------------------------------------
async function buildBrief(business) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      // Verify the current model id at docs.claude.com — Sonnet is plenty for this.
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            `You are a creative director making short social promo videos for Indian ` +
            `small businesses. Reply with ONLY a JSON object, no markdown, no preamble, ` +
            `matching exactly:\n` +
            `{\n` +
            `  "image_prompt": "photoreal hero-frame prompt, on-brand, no text overlays",\n` +
            `  "video_prompt": "cinematic camera + subject motion for that frame",\n` +
            `  "motion": "Zoom In | Push In | Orbit | Crane Up",\n` +
            `  "aspect_ratio": "9:16"\n` +
            `}\n` +
            `Pick 9:16 for Reels/Stories, 1:1 for feed posts.\n\n` +
            `Business details: ${JSON.stringify(business)}`,
        },
      ],
    }),
  });

  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ---------------------------------------------------------------------------
// 2) Hero frame. Higgsfield video is image->video, so we ALWAYS need a still
//    first. If the client gave you a real product photo, use it (better trust
//    + no AI-look). Otherwise generate one.
// ---------------------------------------------------------------------------
async function makeHeroImage(brief, existingUrl) {
  if (existingUrl) return existingUrl;

  const jobSet = await higgsfield.subscribe(
    'flux-pro/kontext/max/text-to-image',
    {
      input: {
        prompt: brief.image_prompt,
        aspect_ratio: brief.aspect_ratio,
        safety_tolerance: 2,
      },
      withPolling: true,
    }
  );

  if (!jobSet.isCompleted) throw new Error(`Image gen not completed: ${jobSet.id}`);
  return jobSet.jobs[0].results.raw.url;
}

// ---------------------------------------------------------------------------
// 3) Animate the still into a ~5s promo clip with the DoP model.
// ---------------------------------------------------------------------------
async function makeVideo(brief, imageUrl) {
  const jobSet = await higgsfield.subscribe('/v1/image2video/dop', {
    input: {
      model: 'dop-turbo', // dop-lite (cheapest) | dop-turbo | dop-standard (best)
      prompt: brief.video_prompt,
      input_images: [{ type: 'image_url', image_url: imageUrl }],
    },
    withPolling: true,
  });

  if (!jobSet.isCompleted) throw new Error(`Video gen not completed: ${jobSet.id}`);
  return jobSet.jobs[0].results.raw.url;
}

// ---------------------------------------------------------------------------
// 4) Persist to Supabase with status pending_approval — your owner-approval
//    gate reads this row; nothing publishes until you tap approve.
// ---------------------------------------------------------------------------
async function saveForApproval(row) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/promo_videos`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async (req) => {
  try {
    const { business, heroImageUrl, clientId } = await req.json();

    const brief = await buildBrief(business);
    const hero = await makeHeroImage(brief, heroImageUrl);
    const videoUrl = await makeVideo(brief, hero);

    await saveForApproval({
      client_id: clientId,
      hero_url: hero,
      video_url: videoUrl, // mirror to Cloudinary later — Higgsfield URLs can expire
      brief,
      status: 'pending_approval',
      created_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ ok: true, clientId, videoUrl }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
