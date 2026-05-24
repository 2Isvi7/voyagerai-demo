import { color, font, radius, space } from '../lib/tokens';

export default function Stub({ title, phase = 1, note }) {
  return (
    <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text }}>
      <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>{title}</h1>
      <div
        style={{
          marginTop: space.xl,
          padding: space.xl,
          background: color.surface,
          border: `1px dashed ${color.borderHi}`,
          borderRadius: radius.lg,
          color: color.textDim,
          fontSize: font.size.body,
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: color.text }}>Coming in Phase {phase}.</strong>
        {note && (
          <>
            <br />
            <span>{note}</span>
          </>
        )}
      </div>
    </div>
  );
}
