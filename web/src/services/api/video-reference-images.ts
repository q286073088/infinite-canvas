import i18n from "@/i18n";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

/** Compress request copies only; the original assets stay in local storage. */
export async function compressGrokReferenceImages(references: ReferenceImage[], signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    if (!references.length) return [];
    const { default: imageCompression } = await import("browser-image-compression");
    // Budget the whole image set, leaving room for Base64 expansion and JSON fields.
    const maxBytes = Math.floor((512 * 1024) / references.length);
    const images: string[] = [];
    for (const reference of references) {
        signal?.throwIfAborted();
        try {
            const dataUrl = await imageToDataUrl(reference, { signal });
            const file = await imageCompression(dataUrlToFile({ ...reference, dataUrl }), {
                maxSizeMB: maxBytes / (1024 * 1024),
                maxWidthOrHeight: 1280,
                fileType: "image/jpeg",
                initialQuality: 0.8,
                useWebWorker: false,
                signal,
            });
            if (!file.size || file.size > maxBytes) throw new Error(i18n.t("apiErrors.grokImageTooLarge"));
            images.push(await readFileAsDataUrl(file));
        } catch (error) {
            signal?.throwIfAborted();
            throw new Error(i18n.t("apiErrors.grokImageCompressionFailed", { name: reference.name, message: error instanceof Error ? error.message : String(error) }));
        }
    }
    signal?.throwIfAborted();
    return images;
}
