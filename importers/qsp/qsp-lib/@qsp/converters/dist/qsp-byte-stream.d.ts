export declare const QSP_CODREMOV = 5;
export declare const QSP_GAMEID = "QSPGAME";
export declare const QSP_PASSWD = "No";
export declare class QspByteStream {
    private cursor;
    private content;
    private view;
    private isUnicode;
    constructor(fromBuffer?: ArrayBuffer);
    private ensureSize;
    finalize(): ArrayBuffer;
    get eof(): boolean;
    read(): number;
    readLine(shouldDecode?: boolean): string;
    write(value: number): void;
    writeString(input: string, shouldEncode?: boolean): void;
    writeLine(input: string, shouldEncode?: boolean): void;
    seek(offset: number): void;
}
