/** Things the UI can offer after an error. Shared by the catalog (errors.ts) and i18n. */
export type ErrorAction =
  | 'retry'
  | 'useQr'
  | 'keepWaiting'
  | 'copyLink'
  | 'configureTurn'
  | 'learnMore'
  | 'askNewLink'
  | 'startOver'
  | 'tryAgain'
  | 'chooseFolder'
  | 'reload';
