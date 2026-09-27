export declare const PACKAGE_DIR: string;
export declare const TEMPLATES: readonly string[];
export declare function validateId(id: string): string | null;
export declare function slug(text: string): string;
export declare function titleCase(text: string): string;
export declare function commandPrefix(id: string): string;
export declare function vendorSources(packageDir?: string): Promise<{ sdk: string; api: string }>;
export declare function render(text: string, vars: Record<string, unknown>): string;
export declare function scaffold(options: {
  targetDir: string;
  id: string;
  name: string;
  publisher: string;
  template?: 'vanilla' | 'react';
  packageDir?: string;
}): Promise<string[]>;
