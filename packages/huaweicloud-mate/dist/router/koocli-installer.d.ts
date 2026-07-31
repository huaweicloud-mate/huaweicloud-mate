export declare const KooCLI_BINARY_PATH: string;
export interface InstallResult {
    success: boolean;
    alreadyInstalled: boolean;
    version?: string;
    path: string;
    error?: string;
}
export declare function ensureKooCLI(): Promise<InstallResult>;
