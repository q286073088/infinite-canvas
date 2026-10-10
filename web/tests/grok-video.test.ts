import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import axios, { type AxiosRequestConfig } from "axios";
import type { AiConfig } from "../src/stores/use-config-store";

const originals = ["localStorage", "FileReader"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
    result = "";
    onload?: () => void;
    async readAsDataURL(blob: Blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
        this.onload?.();
    }
} });
const originalAdapter = axios.defaults.adapter;
const requests: AxiosRequestConfig[] = [];
let compressionFailure = "";
let compressionOversize = false;
let cancelCompression: (() => void) | undefined;
let compressedInputs: File[] = [];
mock.module("browser-image-compression", () => ({ default: async (file: File) => {
    compressedInputs.push(file);
    if (compressionFailure) throw new Error(compressionFailure);
    cancelCompression?.();
    return new File([compressionOversize ? new Uint8Array(600 * 1024) : await file.arrayBuffer()], file.name, { type: "image/jpeg" });
} }));
beforeEach(() => {
    requests.length = 0;
    compressedInputs = [];
    compressionFailure = "";
    compressionOversize = false;
    cancelCompression = undefined;
});
axios.defaults.adapter = async (request) => {
    requests.push(request);
    const data = request.responseType === "blob" ? new Blob(["video"], { type: "video/mp4" })
        : request.url?.includes(":predictLongRunning") ? { name: "operations/video-test" }
        : request.url?.includes("/operations/") ? { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://example.invalid/result.mp4" } }] } } }
        : request.method === "post" ? { id: "video-test" } : { status: "completed" };
    return { status: 200, statusText: "OK", headers: {}, config: request, data };
};
afterAll(() => {
    axios.defaults.adapter = originalAdapter;
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const { defaultConfig } = await import("../src/stores/use-config-store");
const { createVideoGenerationTask } = await import("../src/services/api/video");
const { getPluginTemplates } = await import("../src/services/api/model-plugin");
const images = ["one", "two", "three"].map((text) => ({ id: text, name: `${text}.png`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(text)}` }));
const compressedUrl = (image: typeof images[number]) => image.dataUrl.replace("image/png", "image/jpeg");

for (const scripted of [false, true]) {
    const config: AiConfig = {
        ...defaultConfig, model: "test::grok-imagine-video", size: "16:9", vquality: "720", videoSeconds: "8",
        channels: [{ id: "test", name: "Test", baseUrl: "https://example.invalid/v1", apiKey: "test-key", apiFormat: "openai", models: [{ name: "grok-imagine-video", capability: "video", script: scripted ? getPluginTemplates().video[0].script : "" }] }],
    };
    for (const [mode, count] of [["frames", 0], ["frames", 1], ["frames", 2], ["frames", 3], ["reference", 1]] as const) {
        test(`${scripted ? "template" : "built-in"}: Grok ${mode} with ${count} images uses the New API JSON contract`, async () => {
            requests.length = 0;
            await createVideoGenerationTask({ ...config, videoMode: mode }, "A flower moves", images.slice(0, count));
            const request = requests[0];
            expect(request.url).toBe("https://example.invalid/v1/videos");
            expect(request.data).not.toBeInstanceOf(FormData);
            const body = JSON.parse(request.data);
            expect(body).toMatchObject({ model: "grok-imagine-video", prompt: "A flower moves", seconds: 8, resolution: "720p", generate_audio: true });
            if (mode === "reference" || count > 2) {
                expect(body.reference_images).toEqual(images.slice(0, count).map((image) => ({ url: compressedUrl(image) })));
                expect(body.image).toBeUndefined();
                expect(body.last_frame).toBeUndefined();
            } else {
                expect(body.image).toEqual(count ? { url: compressedUrl(images[0]) } : undefined);
                expect(body.last_frame).toEqual(count === 2 ? { url: compressedUrl(images[1]) } : undefined);
                expect(body.reference_images).toBeUndefined();
            }
            expect(images[0].dataUrl).toStartWith("data:image/png;");
        });
    }
    test(`${scripted ? "template" : "built-in"}: Grok forwards reference audio as a data URL`, async () => {
        requests.length = 0;
        const url = "data:audio/mpeg;base64,YXVkaW8=";
        await createVideoGenerationTask(config, "A flower moves", [], { audios: [{ id: "audio", name: "ref.mp3", url, type: "audio/mpeg" }] });
        expect(JSON.parse(requests[0].data).reference_audios).toEqual([{ url }]);
    });
    test(`${scripted ? "template" : "built-in"}: reference videos are not silently discarded`, async () => {
        requests.length = 0;
        await expect(createVideoGenerationTask(config, "Edit video", [], { videos: [{ id: "video", name: "ref.mp4", type: "video/mp4", url: "data:video/mp4;base64,dmlkZW8=" }] })).rejects.toThrow("视频编辑");
        expect(requests).toHaveLength(0);
    });
    test(`${scripted ? "template" : "built-in"}: other video models retain their multipart request`, async () => {
        requests.length = 0;
        const channel = config.channels[0];
        await createVideoGenerationTask({ ...config, model: "test::other-video", videoMode: "frames", channels: [{ ...channel, models: [{ ...channel.models[0], name: "other-video" }] }] }, "A flower moves", images.slice(0, 1));
        expect(requests[0].data).toBeInstanceOf(FormData);
        expect(requests[0].data.get("first_frame")).toBeInstanceOf(File);
        expect(compressedInputs).toHaveLength(0);
        expect(await requests[0].data.get("first_frame").text()).toBe("one");
    });
    test(`${scripted ? "template" : "built-in"}: Gemini keeps its original image and aspect ratio`, async () => {
        const channel = config.channels[0];
        await createVideoGenerationTask({ ...config, model: "test::veo", size: "9:16", channels: [{ ...channel, apiFormat: "gemini", models: [{ name: "veo", capability: "video", script: scripted ? getPluginTemplates().video[1].script : "" }] }] }, "A flower moves", images.slice(0, 1));
        const body = JSON.parse(requests[0].data);
        expect(body.instances[0].image).toEqual({ bytesBase64Encoded: "b25l", mimeType: "image/png" });
        expect(body.parameters.aspectRatio).toBe("9:16");
        expect(compressedInputs).toHaveLength(0);
    });
    for (const reason of ["decode", "oversize", "cancel"] as const) {
        test(`${scripted ? "template" : "built-in"}: ${reason} during compression prevents the generation request`, async () => {
            const controller = new AbortController();
            if (reason === "decode") compressionFailure = "Cannot decode image";
            if (reason === "oversize") compressionOversize = true;
            if (reason === "cancel") cancelCompression = () => controller.abort();
            await expect(createVideoGenerationTask(config, "A flower moves", images, { signal: controller.signal })).rejects.toThrow(reason === "decode" ? "Cannot decode image" : reason === "oversize" ? "体积目标" : "abort");
            expect(requests).toHaveLength(0);
            expect(compressedInputs).toHaveLength(1);
        });
    }
}
