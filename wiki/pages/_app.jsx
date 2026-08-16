import { useEffect, useState } from 'react'
import '../styles/globals.css'

function ImageLightbox() {
  const [activeImg, setActiveImg] = useState(null)

  useEffect(() => {
    const handleClick = (e) => {
      const target = e.target
      if (
        target instanceof HTMLImageElement &&
        !target.closest('.lightbox-container') &&
        !target.classList.contains('no-lightbox')
      ) {
        // Capture caption from sibling or alt text
        let caption = target.alt || ''
        const parent = target.parentElement
        if (parent) {
          const next = target.nextElementSibling || parent.querySelector('.screenshot-caption')
          if (next && next.classList.contains('screenshot-caption')) {
            caption = next.textContent || caption
          }
        }

        setActiveImg({
          src: target.src,
          alt: target.alt || caption,
          caption,
        })
      }
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setActiveImg(null)
      }
    }

    document.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  if (!activeImg) return null

  return (
    <div className="lightbox-overlay" onClick={() => setActiveImg(null)} role="dialog" aria-modal="true">
      <div className="lightbox-container" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="lightbox-close"
          onClick={() => setActiveImg(null)}
          aria-label="Close fullsize image"
        >
          ✕
        </button>
        <img
          src={activeImg.src}
          alt={activeImg.alt}
          className="lightbox-img"
          onClick={() => setActiveImg(null)}
        />
        {activeImg.caption && (
          <div className="lightbox-caption">{activeImg.caption}</div>
        )}
      </div>
    </div>
  )
}

export default function App({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <ImageLightbox />
    </>
  )
}
