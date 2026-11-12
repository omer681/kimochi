/** Settings → Translation & AI: translation (your DeepL key or Kimochi cloud), the Explain action for Log lines, and voice chat. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Select, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { ExplainSettingsModal } from '@texthooker/components/ExplainSettingsModal'
import { updateSettings } from '@texthooker/lib/settings'
import { deeplTranslates } from '@texthooker/lib/translateLanguage'
import type { Settings, TranslationProvider } from '@texthooker/lib/types'
import { translationRoute } from '@ui/account'
import type { Language } from '@ui/languages'
import { useAccount } from '../../bridge/account'
import { useLanguage } from '../../bridge/useLanguage'
import { openSettings } from '../../bridge/tauri'
import { useSetting } from '../../bridge/useSetting'
import { WithReaderSettings } from './ReaderSettingsProvider'

export function AssistTab(): ReactNode {
  return (
    <SettingsPage
      title="Translation & AI"
      description="Help with a line you can't read yet: from each line's menu in the Log, or by voice over the overlay."
    >
      <WithReaderSettings>{(settings) => <AssistSections settings={settings} />}</WithReaderSettings>
    </SettingsPage>
  )
}

/** The two choices. A stored `'auto'` (never chosen) shows as what it does now: `shownProvider`. */
const PROVIDERS: { value: Exclude<TranslationProvider, 'auto'>; label: string }[] = [
  { value: 'kimochi', label: 'Kimochi cloud' },
  { value: 'deepl', label: 'Your DeepL key' }
]

/** `'auto'` is Kimochi cloud with Kimochi Cloud and your DeepL key otherwise (`translationRoute`). */
function shownProvider(provider: TranslationProvider | undefined, cloud: boolean): 'kimochi' | 'deepl' {
  if (provider === 'kimochi' || provider === 'deepl') return provider
  return cloud ? 'kimochi' : 'deepl'
}

/** Which provider translates, and whether it can: DeepL takes only some languages. */
function providerDescription(settings: Settings, cloud: boolean, language: Language): string {
  if (shownProvider(settings.translationProvider, cloud) === 'kimochi') {
    return cloud ? 'Uses your Kimochi Cloud monthly translations.' : 'Needs Kimochi Cloud: see Settings → Account.'
  }
  if (!deeplTranslates(language.code)) return `DeepL can't translate from ${language.name}. Choose Kimochi cloud.`
  return translationRoute('deepl', settings.deeplApiKey, cloud)
    ? 'Lines are translated with your DeepL key.'
    : 'Add your DeepL API key below.'
}

function AssistSections({ settings }: { settings: Settings }): ReactNode {
  const { cloud } = useAccount()
  const [language] = useLanguage()
  const [deeplDraft, setDeeplDraft] = useState(settings.deeplApiKey)
  const [explainOpen, setExplainOpen] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft follows outside changes
  useEffect(() => setDeeplDraft(settings.deeplApiKey), [settings.deeplApiKey])
  const provider = shownProvider(settings.translationProvider, cloud)

  const explainSummary =
    settings.explainProvider === 'kimochi'
      ? cloud
        ? 'Kimochi cloud'
        : 'Kimochi cloud (needs Kimochi Cloud, see Settings → Account)'
      : settings.explainProvider === 'claude'
        ? `Claude CLI · ${settings.explainClaudeModel}`
        : `Codex CLI${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ''}`

  return (
    <div className="texthooker">
      <SettingsSection title="Translation">
        <SettingsRow label="Translate with" description={providerDescription(settings, cloud, language)}>
          <Select
            aria-label="Translate with"
            value={provider}
            onValueChange={(value) => void updateSettings({ translationProvider: value as TranslationProvider })}
            // Kimochi cloud is offered with Kimochi Cloud; still listed while it is the choice.
            options={PROVIDERS.filter((p) => p.value !== 'kimochi' || cloud || provider === 'kimochi')}
          />
          {provider === 'kimochi' && !cloud && (
            <Button size="sm" onClick={() => void openSettings('account')}>
              Account…
            </Button>
          )}
        </SettingsRow>
        {provider !== 'kimochi' && (
          <SettingsRow
            label="DeepL API key"
            controlId="assist-deepl"
            description={settings.deeplApiKey.trim() ? 'Enter your DeepL key' : 'Stored in settings.json.'}
          >
            <Input
              id="assist-deepl"
              type="password"
              mono
              autoComplete="off"
              className="settings-field"
              value={deeplDraft}
              onChange={(e) => setDeeplDraft(e.target.value)}
              onBlur={() => {
                const next = deeplDraft.trim()
                if (next !== settings.deeplApiKey) void updateSettings({ deeplApiKey: next })
              }}
              placeholder="xxxxxxxx-…-xxxxxxxx:fx"
            />
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title="Explain with AI">
        <SettingsRow label="Provider, model and prompt" description={`${explainSummary}. Also on the E key.`}>
          <Button size="sm" onClick={() => setExplainOpen(true)}>
            Configure…
          </Button>
        </SettingsRow>
      </SettingsSection>
      <ExplainSettingsModal open={explainOpen} onOpenChange={setExplainOpen} settings={settings} />
      <VoiceChatSection />
    </div>
  )
}

/** GPT-Live's voices (src-tauri/src/voice_chat.rs `VOICES`); Marin is the default. */
const VOICES = [
  'marin',
  'quartz',
  'ripple',
  'vesper',
  'willow',
  'stone',
  'gleam',
  'meridian',
  'bossa',
  'tempo',
  'beacon',
  'delta',
  'cinder',
  'nuri',
  'juni',
  'flitz',
  'brise',
  'sillage',
  'nira',
  'harema',
  'shida',
  'noeul'
].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))

/**
 * Voice chat: a short spoken chat about the overlay's text with OpenAI's GPT-Live, on its
 * shortcut. The key is read by native only (`voice_chat_connect`); it is a secret by its name, so
 * it never syncs.
 */
function VoiceChatSection(): ReactNode {
  const [key, setKey] = useSetting<string>('voiceChat.openaiApiKey', '')
  const [voice, setVoice] = useSetting<string>('voiceChat.voice', 'marin')
  const [draft, setDraft] = useState(key)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft follows outside changes
  useEffect(() => setDraft(key), [key])
  return (
    <SettingsSection
      title="Voice chat"
      description="Talk with an AI tutor about the text on the overlay. Press the Voice chat shortcut, ask, and press it again to end."
    >
      <SettingsRow
        label="OpenAI API key"
        controlId="assist-openai"
        description="Voice chat uses OpenAI's GPT-Live, billed to this key by the second. Stored in settings.json."
      >
        <Input
          id="assist-openai"
          type="password"
          mono
          autoComplete="off"
          className="settings-field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const next = draft.trim()
            if (next !== key) void setKey(next)
          }}
          placeholder="sk-…"
        />
      </SettingsRow>
      <SettingsRow label="Voice">
        <Select aria-label="Voice" value={voice} onValueChange={(value) => void setVoice(value)} options={VOICES} />
      </SettingsRow>
      <SettingsRow label="Shortcut" description="Off until you turn it on.">
        <Button size="sm" onClick={() => void openSettings('controls')}>
          Shortcuts…
        </Button>
      </SettingsRow>
    </SettingsSection>
  )
}
