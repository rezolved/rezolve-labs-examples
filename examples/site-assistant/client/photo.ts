/**
 * A visitor's photo, made small enough to send: at most 1,024 pixels across, as a JPEG `data:` URL of about 200 KB.
 * A phone's photo is often 4 MB or more; the search needs no more than this.
 */
const SIDE = 1024;

/** The photo as a data: URL. Rejects a file the browser can't read as an image (some phones' HEIC on a desktop). */
export async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file); // turned the right way up, as the phone took it
  const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}
