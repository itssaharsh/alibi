/** The demo video, when the build found one beside the page. Written at build time as video.json. */
export interface Video {
  file: string;
  poster?: string;
  captions?: string;
  seconds?: number;
}

const url = (path: string): string => new URL(import.meta.env.BASE_URL + path.replace(/^\//, ''), location.href).toString();
export const videoUrl = url;

/** Undefined when there is no video: a missing file, or a server that answers a missing path with the page itself. */
export async function loadVideo(): Promise<Video | undefined> {
  try {
    const response = await fetch(url('video.json'));
    if (!response.ok) return undefined;
    const json = (await response.json()) as Partial<Video>;
    return typeof json.file === 'string' && json.file ? (json as Video) : undefined;
  } catch {
    return undefined;
  }
}

/** `152` seconds reads `2:32`. */
export function minutes(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
