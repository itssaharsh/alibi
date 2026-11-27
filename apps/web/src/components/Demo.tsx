import type { Video } from '../lib/video';
import { minutes, videoUrl } from '../lib/video';

export function DemoLink({ video }: { video: Video }) {
  return (
    <a
      className="demo-link"
      href="#demo"
      onClick={(e) => {
        e.preventDefault();
        const section = document.getElementById('demo');
        const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        section?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
        section?.querySelector('video')?.focus({ preventScroll: true });
      }}
    >
      Watch the demo{video.seconds ? ` (${minutes(video.seconds)})` : ''}
    </a>
  );
}

/** The video loads nothing until play is pressed (preload none), so the first screen weighs what it did. */
export function Demo({ video }: { video: Video }) {
  return (
    <section id="demo" className="card demo" aria-label="The demo">
      <h2>The demo</h2>
      <video controls preload="none" playsInline poster={video.poster ? videoUrl(video.poster) : undefined}>
        <source src={videoUrl(video.file)} type="video/mp4" />
        {video.captions ? <track kind="captions" src={videoUrl(video.captions)} srcLang="en" label="English" default /> : null}
      </video>
    </section>
  );
}
