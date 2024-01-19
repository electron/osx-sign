export type ElectronMacPlatform = 'darwin' | 'mas';
type SigningDistributionType = 'development' | 'distribution';

export type BaseSignOptions = Readonly<{
  app: string;
  identity?: string;
  platform?: ElectronMacPlatform;
  keychain?: string;
}>;

type OnlyValidatedBaseSignOptions = {
  platform: ElectronMacPlatform;
};

/**
 * Any missing options will use the default values, providing a partial
 * structure will shallow merge with the default values.
 */
export type PerFileSignOptions = {
  /**
   * The entitlements file to use when signing this file
   */
  entitlements?: string | string[];
  /**
   * Whether to enable hardened runtime for this file.  Enabled by default.
   */
  hardenedRuntime?: boolean;
  /**
   * The designated requirements to embed when signing this file. Expects a path to a text file.
   */
  requirements?: string;
  /**
   * See --options of the "codesign" command.
   *
   * https://www.manpagez.com/man/1/codesign
   */
  signatureFlags?: string | string[];
  /**
   * The timestamp server to use when signing, by default uses the Apple provided
   * timestamp server.
   */
  timestamp?: string;
}

type OnlySignOptions = {
  binaries?: string[];
  optionsForFile?: (filePath: string) => PerFileSignOptions;
  identityValidation?: boolean;
  ignore?: string | string[] | ((file: string) => boolean);
  preAutoEntitlements?: boolean;
  preEmbedProvisioningProfile?: boolean;
  provisioningProfile?: string;
  strictVerify?: boolean;
  type?: SigningDistributionType;
  version?: string;
  useDeepFlag?: boolean;
};

type OnlyValidatedSignOptions = {
  ignore?: (string | ((file: string) => boolean))[];
  type: SigningDistributionType;
};

type OnlyFlatOptions = {
  identityValidation?: boolean;
  install?: string;
  pkg?: string;
  scripts?: string;
};

type OnlyValidatedFlatOptions = {
  install: string;
  pkg: string;
};

type ValidatedForm<UnValidated, Validated> = Omit<UnValidated, keyof Validated> & Validated;

export type ValidatedBaseSignOptions = Readonly<ValidatedForm<BaseSignOptions, OnlyValidatedBaseSignOptions>>;
export type SignOptions = Readonly<OnlySignOptions & BaseSignOptions>;
export type ValidatedSignOptions = Readonly<ValidatedForm<OnlySignOptions, OnlyValidatedSignOptions> &
  ValidatedBaseSignOptions>;
export type FlatOptions = Readonly<OnlyFlatOptions & BaseSignOptions>;
export type ValidatedFlatOptions = Readonly<ValidatedForm<OnlyFlatOptions, OnlyValidatedFlatOptions> &
  ValidatedBaseSignOptions>;
