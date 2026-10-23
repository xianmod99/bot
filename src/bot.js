require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}
const bot = new Telegraf(TOKEN);
const TEMP_ROOT = process.env.TEMP_DIR || path.join(os.tmpdir(), "clipforge");
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const settingsByUser = new Map();
const activeUsers = new Set();
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_VIDEO_MINUTES || 30));
const MAX_CLIPS = Math.max(1, Math.min(5, Number(process.env.MAX_CLIPS || 3)));
const DEFAULT_SECONDS = Math.max(20, Math.min(60, Number(process.env.DEFAULT_CLIP_SECONDS || 45)));
const MAX_DOWNLOAD_MB = Math.max(100, Number(process.env.MAX_DOWNLOAD_MB || 700));
const W = Number(process.env.OUTPUT_WIDTH || 1080);
const H = Number(process.env.OUTPUT_HEIGHT || 1920);
const ALLOWED = (process.env.ALLOWED_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const STYLES = {
  karaoke: { label: "🎤 Karaoke", font: "Arial", size: 68, primary: "&H0000FFFF", outline: 5, bold: 1, shadow: 2 },
  bold:    { label: "🔥 Bold Shorts", font: "Arial", size: 72, primary: "&H00FFFFFF", outline: 6, bold: 1, shadow: 3 },
  clean:   { label: "✨ Clean", font: "Arial", size: 48, primary: "&H00FFFFFF", outline: 3, bold: 0, shadow: 1 },
  classic: { label: "📺 Classic", font: "Arial", size: 52, primary: "&H00FFFFFF", outline: 2, bold: 0, shadow: 1 }
};

function allowed(ctx) {
  return ALLOWED.length === 0 || ALLOWED.includes(String(ctx.from?.id));
}
function getSettings(id) {
  if (!settingsByUser.has(id)) settingsByUser.set(id, { style: "karaoke", seconds: DEFAULT_SECONDS });
  return settingsByUser.get(id);
}
function openaiClient(provider) {
  if (provider === "groq" && process.env.GROQ_API_KEY) {
    return new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return null;
}
function providerOrder() {
  const preferred = (process.env.AI_PROVIDER || "groq").toLowerCase();
  return preferred === "openai" ? ["openai", "groq"] : ["groq", "openai"];
}
async function withProvider(fn) {
  let lastErr;
  for (const provider of providerOrder()) {
    const client = openaiClient(provider);
    if (!client) continue;
    try { return await fn(client, provider); }
    catch (e) { lastErr = e; console.error(`${provider} API error:`, e.message); }
  }
  throw lastErr || new Error("No AI provider configured. Add GROQ_API_KEY and/or OPENAI_API_KEY.");
}
function safeName(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "job"; }
async function run(command, args, opts = {}) {
  return execFileAsync(command, args, { maxBuffer: 20 * 1024 * 1024, ...opts });
}
function parseJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI returned invalid JSON.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
function fmtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(2);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(5,"0")}`;
}
function assTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), cs = Math.floor((s % 1) * 100);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}
function escAss(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}").replace(/\r?\n/g, " ");
}
function makeAss(segments, styleKey, duration) {
  const st = STYLES[styleKey] || STYLES.karaoke;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${st.font},${st.size},${st.primary},&H0000FFFF,&H00101010,&H80000000,${st.bold},0,1,${st.outline},${st.shadow},2,70,70,210,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  for (const seg of (segments || [])) {
    const start = Math.max(0, Number(seg.start) || 0);
    const end = Math.min(duration, Number(seg.end) || start + 2);
    if (end <= start) continue;
    const words = String(seg.text || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let text;
    if (styleKey === "karaoke") {
      const totalCs = Math.max(words.length * 8, Math.round((end - start) * 100));
      const each = Math.max(1, Math.floor(totalCs / words.length));
      text = words.map(w => `{\\k${each}}${escAss(w)}`).join(" ");
    } else {
      text = escAss(words.join(" "));
    }
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return header + events.join("\n") + "\n";
}
async function downloadVideo(url, dir) {
  // Restrict to http(s) URLs; yt-dlp itself handles supported public sources.
  if (!/^https?:\/\//i.test(url)) throw new Error("Link harus berupa URL http/https.");
  const out = path.join(dir, "source.%(ext)s");
  await run("yt-dlp", [
    "--no-playlist", "--no-warnings", "--restrict-filenames",
    "--max-filesize", `${MAX_DOWNLOAD_MB}M`,
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format", "mp4",
    "-o", out, url
  ], { timeout: 15 * 60 * 1000 });
  const candidates = fs.readdirSync(dir).filter(n => n.startsWith("source.") && !n.endsWith(".part"));
  const video = candidates.map(n => path.join(dir, n)).find(p => /\.(mp4|mkv|webm|mov|m4v)$/i.test(p));
  if (!video) throw new Error("Video tidak ditemukan setelah diunduh. Coba tautan publik lain.");
  const sizeMb = fs.statSync(video).size / 1024 / 1024;
  if (sizeMb > MAX_DOWNLOAD_MB) throw new Error(`File melebihi batas ${MAX_DOWNLOAD_MB} MB.`);
  return video;
}
async function probeVideo(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:format_tags=title", "-of", "json", file]);
  const data = JSON.parse(stdout);
  return { duration: Number(data.format?.duration || 0), title: data.format?.tags?.title || path.basename(file) };
}
async function transcribe(video, dir) {
  const audio = path.join(dir, "audio.mp3");
  await run("ffmpeg", ["-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audio], { timeout: 10 * 60 * 1000 });
  return withProvider(async (client, provider) => {
    const model = provider === "groq" ? (process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo") : (process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(audio),
      model,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });
    return { text: result.text || "", segments: result.segments || [] };
  });
}
async function findClips(transcript, duration, maxClips, clipSeconds) {
  return withProvider(async (client, provider) => {
    const model = provider === "groq" ? (process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile") : (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini");
    const transcriptLines = (transcript.segments || []).map(s => `[${Number(s.start).toFixed(1)}-${Number(s.end).toFixed(1)}] ${s.text}`).join("\n").slice(0, 50000);
    const prompt = `Select up to ${maxClips} compelling short-video moments from this transcript. Video duration is ${duration.toFixed(1)} seconds. Aim for each clip to be 20-${clipSeconds} seconds, keep boundaries within the source, avoid overlapping clips, and choose complete thoughts with a strong hook/payoff. Return ONLY JSON: {"clips":[{"start":12.3,"end":48.0,"title":"short title","reason":"why this moment works"}]}. All times are seconds from the original video. Do not invent content.\nTRANSCRIPT:\n${transcriptLines || transcript.text}`;
    const res = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a precise video editor. Return valid JSON only. Use only transcript-supported moments." },
        { role: "user", content: prompt }
      ]
    });
    const parsed = parseJson(res.choices?.[0]?.message?.content || "");
    const clips = (parsed.clips || []).map(c => ({
      start: Math.max(0, Number(c.start) || 0),
      end: Math.min(duration, Number(c.end) || 0),
      title: String(c.title || "AI Clip").slice(0, 80),
      reason: String(c.reason || "").slice(0, 180)
    })).filter(c => c.end > c.start + 5).slice(0, maxClips);
    if (!clips.length) throw new Error("AI tidak menemukan klip yang valid. Coba video lain.");
    return clips;
  });
}
function subtitlesForClip(segments, start, end) {
  return (segments || []).filter(s => Number(s.end) > start && Number(s.start) < end).map(s => ({
    start: Math.max(0, Number(s.start) - start),
    end: Math.max(0.1, Math.min(end, Number(s.end)) - start),
    text: s.text || ""
  }));
}
async function renderClip(video, transcript, clip, index, dir, styleKey) {
  const clipDuration = clip.end - clip.start;
  const assPath = path.join(dir, `clip_${index + 1}.ass`);
  const output = path.join(dir, `clip_${index + 1}.mp4`);
  fs.writeFileSync(assPath, makeAss(subtitlesForClip(transcript.segments, clip.start, clip.end), styleKey, clipDuration), "utf8");
  const assEscaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,subtitles='${assEscaped}'`;
  await run("ffmpeg", [
    "-y", "-ss", String(clip.start), "-i", video, "-t", String(clipDuration),
    "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output
  ], { timeout: 20 * 60 * 1000 });
  return output;
}
async function cleanup(dir) {
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
}
async function processClip(ctx, url) {
  const id = ctx.from.id;
  if (activeUsers.has(id)) {
    await ctx.reply("⏳ Kamu masih punya proses yang berjalan. Tunggu sampai selesai ya.");
    return;
  }
  activeUsers.add(id);
  const dir = path.join(TEMP_ROOT, `${Date.now()}_${safeName(id)}`);
  fs.mkdirSync(dir, { recursive: true });
  const settings = getSettings(id);
  let status;
  try {
    status = await ctx.reply("📥 Mengunduh video... Pastikan kamu punya izin untuk mengolah video ini.");
    const edit = async t => { try { await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t); } catch {} };
    const video = await downloadVideo(url, dir);
    const info = await probeVideo(video);
    if (!info.duration || info.duration > MAX_MINUTES * 60) {
      throw new Error(`Durasi video harus maksimal ${MAX_MINUTES} menit untuk versi awal.`);
    }
    await edit("🎧 Mengekstrak audio dan membuat transkrip...");
    const transcript = await transcribe(video, dir);
    if (!transcript.text.trim()) throw new Error("Tidak ada ucapan yang terdeteksi. Video harus memiliki audio/dialog yang jelas.");
    await edit("🧠 AI sedang memilih momen terbaik...");
    const clips = await findClips(transcript, info.duration, MAX_CLIPS, settings.seconds);
    await edit(`✂️ Ditemukan ${clips.length} klip. Sedang merender video 9:16...`);
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const output = await renderClip(video, transcript, clip, i, dir, settings.style);
      await ctx.replyWithVideo({ source: output }, {
        caption: `🎬 ${clip.title}\n⏱️ ${fmtTime(clip.start)} – ${fmtTime(clip.end)}\n💡 ${clip.reason || "Dipilih AI dari transkrip"}\n🎨 Subtitle: ${STYLES[settings.style].label}`,
        supports_streaming: true
      });
    }
    await edit("✅ Selesai! Semua klip sudah dikirim. Hasilnya tetap perlu kamu tinjau sebelum upload.");
  } catch (e) {
    console.error("Clip job failed:", e);
    const msg = String(e.message || "Kesalahan tidak diketahui").slice(0, 800);
    if (status) {
      try { await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Gagal memproses video.\n\n${msg}\n\nKetik /help untuk panduan.`); }
      catch { await ctx.reply(`❌ Gagal memproses video.\n${msg}`); }
    } else {
      await ctx.reply(`❌ Gagal memproses video.\n${msg}`);
    }
  } finally {
    await cleanup(dir);
    activeUsers.delete(id);
  }
}

bot.start(async ctx => {
  if (!allowed(ctx)) return ctx.reply("Akses bot ini belum diizinkan untuk akun kamu.");
  getSettings(ctx.from.id);
  return ctx.reply(
    "🎬 CLIPFORGE AI\n\nKirim link video publik dengan format:\n/clip https://...\n\nAI akan mencari momen menarik, membuat klip vertikal 9:16, dan menambahkan subtitle.\n\nPilih /settings untuk mengatur gaya subtitle.",
    Markup.inlineKeyboard([
      [Markup.button.callback("⚙️ Pengaturan", "settings"), Markup.button.callback("❓ Bantuan", "help")]
    ])
  );
});
bot.command("help", ctx => ctx.reply(
  "Cara pakai:\n1. Kirim /clip diikuti tautan video publik yang boleh kamu olah.\n2. Tunggu transkripsi dan analisis AI.\n3. Bot mengirim sampai beberapa klip MP4.\n\nBatas awal: durasi video maksimal " + MAX_MINUTES + " menit, ukuran download maksimal " + MAX_DOWNLOAD_MB + " MB.\n\nJika gagal, coba tautan publik lain atau video lebih pendek."
));
bot.command("settings", async ctx => showSettings(ctx));
bot.action("settings", async ctx => { await ctx.answerCbQuery(); await showSettings(ctx); });
async function showSettings(ctx) {
  const s = getSettings(ctx.from.id);
  await ctx.reply(
    `⚙️ PENGATURAN CLIPFORGE\n\nGaya subtitle: ${STYLES[s.style].label}\nTarget durasi: ${s.seconds} detik`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🎤 Karaoke", "style:karaoke"), Markup.button.callback("🔥 Bold Shorts", "style:bold")],
      [Markup.button.callback("✨ Clean", "style:clean"), Markup.button.callback("📺 Classic", "style:classic")],
      [Markup.button.callback("⏱️ 30 detik", "duration:30"), Markup.button.callback("⏱️ 45 detik", "duration:45"), Markup.button.callback("⏱️ 60 detik", "duration:60")]
    ])
  );
}
bot.action(/^style:(karaoke|bold|clean|classic)$/, async ctx => {
  getSettings(ctx.from.id).style = ctx.match[1];
  await ctx.answerCbQuery("Gaya subtitle disimpan");
  await ctx.reply(`Gaya subtitle sekarang: ${STYLES[ctx.match[1]].label}`);
});
bot.action(/^duration:(30|45|60)$/, async ctx => {
  getSettings(ctx.from.id).seconds = Number(ctx.match[1]);
  await ctx.answerCbQuery("Durasi disimpan");
  await ctx.reply(`Target durasi klip: ${ctx.match[1]} detik`);
});
bot.action("help", async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply("Gunakan /clip https://... untuk memproses video. Video harus dapat diakses secara publik dan kamu harus memiliki hak untuk mengolahnya.");
});
bot.command("clip", async ctx => {
  if (!allowed(ctx)) return ctx.reply("Akses bot ini belum diizinkan untuk akun kamu.");
  const url = (ctx.message.text || "").replace(/^\/clip(?:@\w+)?\s*/i, "").trim();
  if (!url) return ctx.reply("Format: /clip https://tautan-video");
  return processClip(ctx, url);
});
bot.on("text", async ctx => {
  if (!allowed(ctx)) return;
  const text = (ctx.message.text || "").trim();
  if (/^https?:\/\//i.test(text)) {
    return ctx.reply("Mau ubah link ini jadi Shorts? Kirim:\n/clip " + text);
  }
});
bot.catch((err, ctx) => {
  console.error("Telegram bot error:", err);
  try { ctx.reply("Terjadi kesalahan pada bot. Coba lagi sebentar."); } catch {}
});
bot.launch().then(() => console.log("ClipForge AI bot started."));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
