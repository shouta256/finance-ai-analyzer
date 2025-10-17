"use client";

export function BackgroundGlows() {
  return (
    <div className="sp-glows" aria-hidden>
      <div className="sp-glow sp-glow-a" />
      <div className="sp-glow sp-glow-b" />
      <style jsx>{`
        .sp-glows {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 0;
          overflow: hidden;
        }
        .sp-glow {
          position: absolute;
          border-radius: 50%;
          filter: blur(60px);
          opacity: 0.7;
          mix-blend-mode: screen;
          will-change: transform;
        }
        .sp-glow-a {
          top: -12vh;
          left: -10vw;
          width: 42vw;
          height: 42vw;
          max-width: 720px;
          max-height: 720px;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(56, 189, 248, 0.35) 0%,
            rgba(56, 189, 248, 0.12) 55%,
            rgba(56, 189, 248, 0) 70%
          );
          animation: sp-drift-a 28s ease-in-out infinite alternate;
        }
        .sp-glow-b {
          right: -14vw;
          bottom: -12vh;
          width: 58vw;
          height: 58vw;
          max-width: 1040px;
          max-height: 1040px;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(168, 85, 247, 0.28) 0%,
            rgba(168, 85, 247, 0.12) 55%,
            rgba(168, 85, 247, 0) 70%
          );
          animation: sp-drift-b 36s ease-in-out infinite alternate;
        }
        @keyframes sp-drift-a {
          0% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(40px, 28px, 0) scale(1.04); }
          100% { transform: translate3d(12px, -18px, 0) scale(1.02); }
        }
        @keyframes sp-drift-b {
          0% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(-32px, -24px, 0) scale(1.03); }
          100% { transform: translate3d(-8px, 20px, 0) scale(1.01); }
        }
      `}</style>
    </div>
  );
}

