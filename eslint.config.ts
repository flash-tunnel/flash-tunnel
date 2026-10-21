import { antfu } from '@antfu/eslint-config'

export default antfu({
  type: 'lib',

  rules: {
    'style/comma-dangle': ['warn', 'never']
  },

  ignores: [
    '**/dist/**',
    '**/coverage/**',
    'ai-docs/**'
  ]
})
