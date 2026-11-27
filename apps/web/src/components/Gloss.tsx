import { useId, type ReactNode } from 'react';
import { GLOSSARY, type Term } from '../lib/glossary';

/** A word with a one-sentence plain explanation on hover or keyboard focus. */
export function Gloss({ term, children }: { term: Term; children?: ReactNode }) {
  const id = useId();
  const [, text] = GLOSSARY[term];
  return (
    <span className="gloss" tabIndex={0} aria-describedby={id}>
      {children ?? term}
      <span role="tooltip" id={id} className="tip">
        {text}
      </span>
    </span>
  );
}

export function WordsUsed() {
  return (
    <section className="card words" aria-label="Words used here">
      <h2>Words used here</h2>
      <dl>
        {(Object.keys(GLOSSARY) as Term[]).map((k) => (
          <div key={k}>
            <dt>{GLOSSARY[k][0]}</dt>
            <dd>{GLOSSARY[k][1]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
