import nextra from 'nextra'

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.jsx',
  defaultShowCopyCode: true,
})

const isProd = process.env.NODE_ENV === 'production'
const basePath = process.env.BASE_PATH ?? (isProd ? '/k7s' : '')

export default withNextra({
  output: 'export',
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  images: {
    unoptimized: true,
  },
})
