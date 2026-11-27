import { useEffect, useRef, useState } from 'react';
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

/**
 * The player is drawn when its section nears the screen, and the video itself loads nothing until play is pressed
 * (preload none), so the first screen weighs what it did before there was a video.
 */
export function Demo({ video }: { video: Video }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: '60px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return (
    <section id="demo" className="card demo" aria-label="The demo">
      <h2>The demo</h2>
      <div ref={box} className="demo-box">
        {near ? (
          <video controls preload="none" playsInline poster={video.poster ? videoUrl(video.poster) : undefined}>
            <source src={videoUrl(video.file)} type="video/mp4" />
            {video.captions ? <track kind="captions" src={videoUrl(video.captions)} srcLang="en" label="English" default /> : null}
          </video>
        ) : null}
      </div>
    </section>
  );
}
