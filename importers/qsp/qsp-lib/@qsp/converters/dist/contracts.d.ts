export interface QspLocation {
    name: string;
    description: string[];
    code: string[];
    actions: QspAction[];
}
export interface QspAction {
    name: string;
    image?: string;
    code: string[];
}
