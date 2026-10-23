# ClipForge AI

Telegram bot prototype: send a supported video URL, transcribe speech, ask an AI model to select moments, and render vertical MP4 clips with subtitles.

## Deploy to Railway
1. Upload this project folder to a GitHub repository.
2. In Railway, create a project from that repository.
3. Add `TELEGRAM_BOT_TOKEN`.
4. Configure at least one provider: `GROQ_API_KEY` and/or `OPENAI_API_KEY`.
5. Deploy. Railway builds the Dockerfile, which installs FFmpeg and yt-dlp.
6. Open the bot in Telegram and send `/start`.

## Commands
- `/start` - main menu
- `/clip <video URL>` - find and render clips
- `/settings` - choose subtitle style and clip length
- `/help` - help

The bot offers four subtitle styles: Karaoke, Bold Shorts, Clean, and Classic. Use the settings buttons.

## Important limits
- Use only videos you own or are authorized to download, edit, and publish.
- Website access, DRM, age gates, private videos, and platform restrictions may prevent downloading.
- Telegram and AI providers impose their own upload, file-size, API, and rate limits.
- Long videos can exceed Railway memory, storage, timeout, or cost limits. Start with short videos.
- AI-selected clips are suggestions, not a guarantee of virality.
- This is a starter implementation; test with a short, permitted video before using it at scale.
# bot
