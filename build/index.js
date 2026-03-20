#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { pipeline } from "stream/promises";
import { isValidSunoMusicRequestArgs } from "./types.js";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", "config.env") });

const CLIENT_TOKEN  = process.env.SunoClientToken;
const CLIENT_UAT    = process.env.SunoClientUat || "1770076756";
const SESSION_ID    = process.env.SunoSessionId;
const DEVICE_ID     = process.env.DeviceId || "ae572371-34a2-492c-9543-9993961d6b33";

if (!CLIENT_TOKEN) throw new Error("SunoClientToken is required in config.env");
if (!SESSION_ID)   throw new Error("SunoSessionId is required in config.env");

const SUNO_API_CONFIG = {
    BASE_URL: "https://studio-api-prod.suno.com",
    ENDPOINTS: {
        SUBMIT_MUSIC: "/api/generate/v2/",
        FETCH_FEED:   "/api/feed/v2",
        STEMS:        "/api/edit/stems/",
        WAV_FILE:     "/api/gen/",
    },
    POLLING_INTERVAL_MS: 5000,
    MAX_POLLING_ATTEMPTS: 72,
};

let cachedToken = null;
let tokenExpiryMs = 0;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

function generateBrowserToken() {
    const b64 = Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString("base64url");
    return JSON.stringify({ token: b64 });
}

async function refreshBearerToken() {
    console.error("[Suno] Refreshing Clerk session token...");
    const resp = await axios.post(
        `https://clerk.suno.com/v1/client/sessions/${SESSION_ID}/tokens`,
        null,
        { headers: { "Cookie": `__client=${CLIENT_TOKEN}; __client_uat=${CLIENT_UAT}`, "Origin": "https://suno.com", "Referer": "https://suno.com/", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" } }
    );
    const jwt = resp.data.jwt;
    if (!jwt) throw new Error(`Clerk refresh returned no jwt: ${JSON.stringify(resp.data)}`);
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    cachedToken = jwt;
    tokenExpiryMs = payload.exp * 1000;
    console.error(`[Suno] Token refreshed, valid until ${new Date(tokenExpiryMs).toISOString()}`);
    return jwt;
}

async function getValidToken() {
    if (!cachedToken || Date.now() >= tokenExpiryMs - REFRESH_MARGIN_MS) await refreshBearerToken();
    return cachedToken;
}

function sanitizeDirName(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function downloadFile(url, destPath) {
    const resp = await axios.get(url, { responseType: "stream" });
    await pipeline(resp.data, fs.createWriteStream(destPath));
}

class SunoMcpServer {
    server;
    api;
    constructor() {
        this.server = new Server(
            { name: "suno-music-generator-mcp", version: "0.3.0" },
            { capabilities: { tools: {} } }
        );
        this.api = axios.create({
            baseURL: SUNO_API_CONFIG.BASE_URL,
            headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Origin": "https://suno.com", "Referer": "https://suno.com/" },
        });
        this.api.interceptors.request.use(async (config) => {
            const token = await getValidToken();
            config.headers["Authorization"] = `Bearer ${token}`;
            config.headers["Cookie"] = `__client=${CLIENT_TOKEN}; __client_uat=${CLIENT_UAT}; __session=${token}`;
            config.headers["browser-token"] = generateBrowserToken();
            config.headers["device-id"] = DEVICE_ID;
            return config;
        });
        this.setupToolHandlers();
        this.setupErrorHandling();
    }
    setupErrorHandling() {
        this.server.onerror = (error) => console.error("[MCP Error]", error instanceof Error ? error.message : error);
        process.on("SIGINT", async () => { await this.server.close(); process.exit(0); });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "generate_music_suno",
                    description: "Generates a song using Suno AI. For custom mode provide lyrics (prompt), style tags, and title. For inspiration mode provide a description (gpt_description_prompt). Returns audio URL(s) and clip ID(s) when complete. Generation takes 1-3 minutes.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            prompt: { type: "string", description: "Lyrics. Required for custom mode." },
                            tags: { type: "string", description: "Style tags, comma-separated. Required for custom mode. E.g. acoustic, folk, pop" },
                            title: { type: "string", description: "Song title. Required for custom mode." },
                            mv: { type: "string", enum: ["chirp-v3-0", "chirp-v3-5", "chirp-v4"], description: "Suno model version. Defaults to chirp-v4." },
                            make_instrumental: { type: "boolean", description: "Generate instrumental (no vocals). Defaults to false." },
                            gpt_description_prompt: { type: "string", description: "Description for inspiration mode. If provided, prompt/tags/title are not required." }
                        },
                        required: []
                    }
                },
                {
                    name: "get_stems_suno",
                    description: "Separates a Suno song into stems and saves them as WAV files in ~/Downloads/<song title>/. Provide the clip_id from a previously generated song. Returns the paths of the saved Vocals.wav and Instrumental.wav files. Takes 1-2 minutes.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            clip_id: { type: "string", description: "The Suno clip ID to separate into stems." }
                        },
                        required: ["clip_id"]
                    }
                },
                {
                    name: "get_wav_suno",
                    description: "Returns the WAV download URL for a Suno clip (original song or stem). Provide the clip_id. WAV files are full quality, uncompressed audio.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            clip_id: { type: "string", description: "The Suno clip ID to get a WAV URL for." }
                        },
                        required: ["clip_id"]
                    }
                }
            ]
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            if (name === "generate_music_suno") return this.handleGenerateMusic(args);
            if (name === "get_stems_suno")      return this.handleGetStems(args);
            if (name === "get_wav_suno")         return this.handleGetWav(args);
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: "${name}"`);
        });
    }

    async handleGetWav(args) {
        const { clip_id } = args;
        if (!clip_id) throw new McpError(ErrorCode.InvalidParams, "clip_id is required");
        try {
            const resp = await this.api.get(`${SUNO_API_CONFIG.ENDPOINTS.WAV_FILE}${clip_id}/wav_file/`);
            const url = resp.data?.wav_file_url || `https://cdn1.suno.ai/${clip_id}.wav`;
            return { content: [{ type: "text", text: `WAV download URL:\n${url}` }] };
        } catch (error) {
            if (axios.isAxiosError(error)) {
                return { content: [{ type: "text", text: `Suno API error (HTTP ${error.response?.status}): ${error.message}` }], isError: true };
            }
            throw new McpError(ErrorCode.InternalError, `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async handleGetStems(args) {
        const { clip_id } = args;
        if (!clip_id) throw new McpError(ErrorCode.InvalidParams, "clip_id is required");
        console.error(`[Suno] Requesting stems for clip ${clip_id}...`);
        try {
            const stemResp = await this.api.post(`${SUNO_API_CONFIG.ENDPOINTS.STEMS}${clip_id}/`);
            const stemClips = stemResp.data?.clips;
            if (!stemClips || stemClips.length === 0) {
                throw new McpError(ErrorCode.InternalError, `No stem clips returned: ${JSON.stringify(stemResp.data)}`);
            }
            const stemIds = stemClips.map((c) => c.id);
            console.error(`[Suno] Stem clips queued: ${stemIds.join(", ")}. Polling...`);

            let completedClips = null;
            for (let attempt = 1; attempt <= SUNO_API_CONFIG.MAX_POLLING_ATTEMPTS; attempt++) {
                await new Promise((r) => setTimeout(r, SUNO_API_CONFIG.POLLING_INTERVAL_MS));
                const feedResp = await this.api.get(SUNO_API_CONFIG.ENDPOINTS.FETCH_FEED, { params: { ids: stemIds.join(",") } });
                const clips = feedResp.data?.clips;
                if (!clips || clips.length === 0) continue;
                const errored = clips.find((c) => c.status === "error");
                if (errored) throw new McpError(ErrorCode.InternalError, `Stem generation failed: ${errored.metadata?.error_message || "Unknown error"}`);
                if (clips.every((c) => c.status === "complete" && c.audio_url)) { completedClips = clips; break; }
                console.error(`[Suno] Stem status: ${clips.map((c) => `${c.title}:${c.status}`).join(", ")}`);
            }
            if (!completedClips) throw new McpError(ErrorCode.InternalError, "Stem generation timed out.");

            // Derive song title from first stem title (e.g. "My Song - Vocals" → "My Song")
            const rawTitle = completedClips[0].title?.replace(/\s*-\s*(Vocals|Instrumental)$/i, "") || clip_id;
            const songDir = sanitizeDirName(rawTitle);
            const outDir = path.join(os.homedir(), "Downloads", songDir);
            fs.mkdirSync(outDir, { recursive: true });
            console.error(`[Suno] Saving stems to ${outDir}`);

            const saved = [];
            for (const clip of completedClips) {
                // Get WAV URL
                let wavUrl;
                try {
                    const wavResp = await this.api.get(`${SUNO_API_CONFIG.ENDPOINTS.WAV_FILE}${clip.id}/wav_file/`);
                    wavUrl = wavResp.data?.wav_file_url;
                } catch (_) {}
                if (!wavUrl) wavUrl = `https://cdn1.suno.ai/${clip.id}.wav`;

                // Determine filename
                const isVocals = clip.title?.toLowerCase().includes("vocal");
                const filename = isVocals ? "Vocals.wav" : "Instrumental.wav";
                const destPath = path.join(outDir, filename);

                console.error(`[Suno] Downloading ${filename} from ${wavUrl}`);
                await downloadFile(wavUrl, destPath);
                saved.push({ label: clip.title, path: destPath });
            }

            let text = `Stems saved to ~/Downloads/${songDir}/\n`;
            for (const s of saved) text += `\n  ${path.basename(s.path)}  ←  ${s.label}`;
            return { content: [{ type: "text", text }] };

        } catch (error) {
            if (axios.isAxiosError(error)) {
                return { content: [{ type: "text", text: `Suno API error (HTTP ${error.response?.status}): ${error.response?.data?.detail || error.message}` }], isError: true };
            }
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async handleGenerateMusic(args) {
        if (!isValidSunoMusicRequestArgs(args)) throw new McpError(ErrorCode.InvalidParams, "Invalid parameters.");
        const isCustomMode = !!(args.prompt || args.tags || args.title);
        const isInspireMode = !!args.gpt_description_prompt;
        if (!isCustomMode && !isInspireMode) throw new McpError(ErrorCode.InvalidParams, "Provide prompt+tags+title for custom mode, or gpt_description_prompt for inspiration mode.");
        if (isCustomMode && (!args.prompt || !args.tags || !args.title)) throw new McpError(ErrorCode.InvalidParams, "Custom mode requires prompt, tags, and title.");
        const payload = { make_instrumental: args.make_instrumental || false, mv: args.mv || "chirp-v4", generation_type: "TEXT" };
        if (isInspireMode && !isCustomMode) { payload.gpt_description_prompt = args.gpt_description_prompt; }
        else { payload.prompt = args.prompt; payload.tags = args.tags; payload.title = args.title; if (args.gpt_description_prompt) payload.gpt_description_prompt = args.gpt_description_prompt; }
        console.error(`[Suno] Submitting ${isCustomMode ? "custom" : "inspire"} generation...`);
        try {
            const submitResponse = await this.api.post(SUNO_API_CONFIG.ENDPOINTS.SUBMIT_MUSIC, payload);
            const clips = submitResponse.data?.clips;
            if (!clips || clips.length === 0 || !clips[0].id) throw new McpError(ErrorCode.InternalError, `No clip IDs returned: ${JSON.stringify(submitResponse.data)}`);
            const clipIds = clips.map((c) => c.id);
            console.error(`[Suno] Clips: ${clipIds.join(", ")}. Polling...`);
            for (let attempt = 1; attempt <= SUNO_API_CONFIG.MAX_POLLING_ATTEMPTS; attempt++) {
                await new Promise((r) => setTimeout(r, SUNO_API_CONFIG.POLLING_INTERVAL_MS));
                const feedResponse = await this.api.get(SUNO_API_CONFIG.ENDPOINTS.FETCH_FEED, { params: { ids: clipIds.join(",") } });
                const resultClips = feedResponse.data?.clips;
                if (!resultClips || resultClips.length === 0) continue;
                const errored = resultClips.find((c) => c.status === "error");
                if (errored) throw new McpError(ErrorCode.InternalError, `Generation failed: ${errored.metadata?.error_message || "Unknown error"}`);
                const complete = resultClips.find((c) => c.status === "complete" && c.audio_url);
                if (complete) {
                    let text = `Song ready!\n\nAudio: ${complete.audio_url}\nClip ID: ${complete.id}`;
                    if (complete.title) text += `\nTitle: ${complete.title}`;
                    if (complete.metadata?.tags) text += `\nStyle: ${complete.metadata.tags}`;
                    if (complete.image_url) text += `\nCover: ${complete.image_url}`;
                    const alt = resultClips.find((c) => c.id !== complete.id && c.status === "complete" && c.audio_url);
                    if (alt) { text += `\n\nAlternative version:\nAudio: ${alt.audio_url}\nClip ID: ${alt.id}`; if (alt.title) text += `\nTitle: ${alt.title}`; }
                    text += `\n\nUse get_stems_suno with a Clip ID to separate and save vocals/instrumental WAV files.\nUse get_wav_suno with a Clip ID to get the WAV download URL.`;
                    return { content: [{ type: "text", text }] };
                }
                console.error(`[Suno] Status: ${resultClips.map((c) => `${c.id.slice(0,8)}:${c.status}`).join(", ")}`);
            }
            throw new McpError(ErrorCode.InternalError, `Timed out after ${(SUNO_API_CONFIG.MAX_POLLING_ATTEMPTS * SUNO_API_CONFIG.POLLING_INTERVAL_MS) / 60000} minutes.`);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                return { content: [{ type: "text", text: `Suno API error (HTTP ${error.response?.status}): ${error.response?.data?.detail || error.response?.data?.message || error.message}` }], isError: true };
            }
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async run() {
        await getValidToken();
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("[Suno MCP] Server ready.");
    }
}

const server = new SunoMcpServer();
server.run().catch((error) => { console.error("[Suno MCP] Failed to start:", error); process.exit(1); });
