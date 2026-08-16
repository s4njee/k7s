import React from 'react'
import { useRouter } from 'next/router'

export default {
  logo: (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '16px', letterSpacing: '-0.02em' }}>
      <span style={{
        background: '#17171a',
        border: '1px solid #2e2e34',
        borderRadius: '5px',
        padding: '2px 7px',
        color: '#4d9fff',
        fontFamily: 'monospace',
        fontSize: '13px',
      }}>
        k7s
      </span>
      <span style={{ color: '#ececf1' }}>Wiki & Docs</span>
    </div>
  ),
  project: {
    link: 'https://github.com/s4njee/k7s',
  },
  docsRepositoryBase: 'https://github.com/s4njee/k7s/tree/main/wiki',
  useNextSeoProps() {
    const { asPath } = useRouter()
    if (asPath !== '/') {
      return {
        titleTemplate: '%s – k7s Documentation',
      }
    }
    return {
      title: 'k7s – Lens-style Kubernetes Visual Monitor',
    }
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta property="og:title" content="k7s Documentation" />
      <meta property="og:description" content="A Lens-style Kubernetes visual monitor built with Tauri + React" />
      <meta name="theme-color" content="#0d0d0f" />
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    </>
  ),
  banner: {
    key: 'k7s-v0.5-release',
    text: (
      <span>
        🚀 k7s v0.5.0 is out with multi-cluster tabs, integrated kubectl PTY terminal, and Helm rollback support!
      </span>
    ),
  },
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    backToTop: true,
  },
  search: {
    placeholder: 'Search documentation (⌘K)...',
  },
  footer: {
    text: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
        <span>k7s — A dark, Lens-style Kubernetes visual monitor built with Tauri + React.</span>
        <span style={{ color: '#70707a' }}>Released under the MIT License. Zero telemetry, local-first.</span>
      </div>
    ),
  },
  darkMode: true,
  nextThemes: {
    defaultTheme: 'dark',
  },
  primaryHue: 213,
  primarySaturation: 100,
}
