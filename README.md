# Website Chatbot

Website Chatbot is a small web app that can learn a public website and answer questions about it in plain language.

You give it a website URL, it crawls a few pages from that site, builds a local knowledge base, and then lets you chat with it about what it found.

## What it does

- Paste a public website URL.
- The app crawls the site and collects text from a few linked pages.
- It builds context from that content.
- You can then ask questions about the website.
- If an external AI provider is unavailable, the app falls back to answering from the crawled website content so the workflow still keeps going.

## What you need

- Node.js 18 or newer
- npm
- One or more supported API keys if you want external AI answers

## Supported AI providers

The app looks for these entries in `API keys.txt`:

- `OpenRouter`
- `Gemini`
- `GROQ`

`Ollama` is the local fallback option. It does not need a secret key, and it can be used when you have Ollama running on your machine.

## API keys file

The app reads keys from a file named `API keys.txt` in the project root.

Use one entry per line in this format:

```txt
OpenRouter - your-openrouter-key
Gemini - your-gemini-key
GROQ - your-groq-key
```

If you also use Ollama locally, the app uses the default local Ollama settings in the code.


Important:

- Keep the file in the project root.
- Do not share the file publicly.
- Only the supported labels above are read by the app.

## Install and run

```bash
npm install
npm run dev
```

Then open the app in your browser at the local address shown in the terminal.

## Helpful scripts

- `npm run dev` starts the app in development mode.
- `npm run build` compiles the TypeScript source into `dist/`.
- `npm run start` runs the compiled app from `dist/`.
- `npm run lint` checks the TypeScript code.
- `npm run smoke` runs a basic crawl and knowledge-base test.
- `npm run check:keys` checks which keys from `API keys.txt` are working.

## How it works

1. You paste a website URL.
2. The server crawls the site and extracts readable text.
3. The app builds a knowledge base from the crawled pages.
4. Your question is sent to the first available AI provider.
5. If that provider fails, the app tries the next one.
6. If all external providers fail, it falls back to local website-context answers.

## Notes

- This app is meant for public websites.
- Very large or heavily protected sites may not crawl cleanly.
- If the site changes after it is crawled, the answers will only reflect the content that was collected during that session.

## Project structure

- `src/` contains the TypeScript source.
- `public/` contains the browser UI.
- `scripts/` contains small utility scripts.
- `dist/` contains compiled output.

## License

No license file is included yet. Add one if you want to publish or share the project more broadly.
