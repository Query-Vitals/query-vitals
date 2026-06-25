/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Developer-tool dark palette (TablePlus / Datadog inspired).
        base: { 900: '#0b0e14', 800: '#11151f', 700: '#1a2030', 600: '#252c40' },
        accent: { DEFAULT: '#5b8def', muted: '#3a5fb0' },
        good: '#3fb950',
        warn: '#d29922',
        bad: '#f85149',
        // macOS 26 "Liquid Glass" surfaces: translucent fills layered over the
        // window vibrancy material (mac) or the opaque base palette (elsewhere).
        glass: {
          // Floating chrome (sidebar / toolbar) — lets vibrancy show through.
          chrome: 'rgb(255 255 255 / 0.05)',
          // Content panels (cards) — denser so dense tables stay legible.
          panel: 'rgb(23 28 41 / 0.72)',
          // Modals / popovers — densest, sits above a blurred scrim.
          raised: 'rgb(26 32 48 / 0.85)',
          // Inset fields (inputs / code) over a glass panel.
          well: 'rgb(11 14 20 / 0.55)',
          // Hairline + specular highlight borders.
          border: 'rgb(255 255 255 / 0.10)',
          highlight: 'rgb(255 255 255 / 0.16)',
        },
      },
      borderRadius: {
        // Concentric scale: outer surfaces rounder than nested controls.
        glass: '1.125rem', // 18px — cards / panels
        'glass-lg': '1.375rem', // 22px — modals / window-level surfaces
      },
      backdropBlur: {
        glass: '20px',
        'glass-lg': '32px',
      },
      boxShadow: {
        // Layered depth + a faint specular top highlight for glass surfaces.
        glass:
          '0 1px 0 0 rgb(255 255 255 / 0.08) inset, 0 8px 24px -8px rgb(0 0 0 / 0.55), 0 2px 6px -2px rgb(0 0 0 / 0.4)',
        'glass-lg':
          '0 1px 0 0 rgb(255 255 255 / 0.1) inset, 0 24px 60px -16px rgb(0 0 0 / 0.7), 0 6px 16px -6px rgb(0 0 0 / 0.5)',
        // Subtle lift used on interactive hover.
        'glass-hover':
          '0 1px 0 0 rgb(255 255 255 / 0.14) inset, 0 12px 30px -8px rgb(0 0 0 / 0.6)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
