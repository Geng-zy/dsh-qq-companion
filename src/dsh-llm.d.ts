// Host typings drift: @deepseek-ai/dsh-llm does not declare this plugin's own
// producer-owned message source kinds. The plugin writes 'plugin:qq-companion';
// sessions from before the rename (and rows the host's v3→v4 converter
// migrated from the retired `{ kind: 'plugin', plugin: 'dsh-onebot' }`) carry
// 'plugin:dsh-onebot'. Augment the map following the host's merge-extensible
// convention (cf. dsh-agent model-selection.d.ts).
import '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:qq-companion': { kind: 'plugin:qq-companion' };
    'plugin:dsh-onebot': { kind: 'plugin:dsh-onebot' };
  }
}
