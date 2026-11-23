export declare const routeContract: { routes: Record<string, string> };
export declare const navigationItems: { label: string; href: string; secondary?: boolean; carrOnly?: boolean }[];
export declare function isRetiredPage(path: string): boolean;
export declare function sessionReturnPath(destination: string): string | null;
