// The insler.dev "Cobalt" code theme — the design system's syntax palette.
// Code panels stay dark in BOTH the light and dark site themes (the Afterdark
// recess never inverts), so this single dark theme is the only one wired into
// Expressive Code; with one theme, EC never swaps to a light variant.
//
// Shape is a plain TextMate/VS Code theme object (name + type + colors +
// settings) so the theme package stays dependency-free — Starlight's Expressive
// Code coerces it into a theme at build time.

// Arrays are mutable (not `readonly`) so the object is structurally assignable
// to Expressive Code's theme input, which expects mutable TextMate settings.
export interface CodeThemeSetting {
  scope?: string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface CodeTheme {
  readonly name: string;
  readonly type: 'dark' | 'light';
  readonly colors: Readonly<Record<string, string>>;
  settings: CodeThemeSetting[];
}

export const cobaltCodeTheme: CodeTheme = {
  name: 'insler-cobalt',
  type: 'dark',
  colors: {
    'editor.background': '#0b0e18',
    'editor.foreground': '#c7cfe6',
  },
  settings: [
    { settings: { background: '#0b0e18', foreground: '#c7cfe6' } },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: '#5e6a8c', fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'storage.type',
        'storage.modifier',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.control.import',
        'keyword.control.export',
      ],
      settings: { foreground: '#62d99a' },
    },
    {
      scope: ['string', 'string.quoted', 'constant.other.symbol', 'punctuation.definition.string'],
      settings: { foreground: '#ff7aa8' },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language',
        'constant.language.boolean',
        'constant.language.null',
      ],
      settings: { foreground: '#ff7aa8' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call.generic',
        'variable.function',
        'entity.name.method',
      ],
      settings: { foreground: '#ff9e57' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.other.inherited-class',
        'meta.type.annotation',
      ],
      settings: { foreground: '#6cb8ff' },
    },
    {
      scope: [
        'variable.other.property',
        'meta.object-literal.key',
        'support.variable.property',
        'variable.other.object.property',
      ],
      settings: { foreground: '#c39dff' },
    },
    {
      scope: [
        'variable',
        'variable.other.readwrite',
        'meta.definition.variable',
        'variable.other.constant',
      ],
      settings: { foreground: '#eff2fb' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator'],
      settings: { foreground: '#c7cfe6' },
    },
  ],
};
