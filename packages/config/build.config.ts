import { defineBuildConfig } from 'unbuild'
import { mergeDefaultBuildConfig } from '../../scripts/build.common'

export default defineBuildConfig(mergeDefaultBuildConfig({
  entries: ['src/index']
}))
