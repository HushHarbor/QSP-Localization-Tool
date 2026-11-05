# QSP file format converters

Converters of different file formats for QSP platform [http://qsp.org/](http://qsp.org/)
## Installation

```bash
npm install --save @qsp/converters
```

## Usage

This library has separate functions for reading and writing file formats. QSP primary format is binary, but there exists also commonly agreed text format. Library references these 2 formats as `qsp` for binary and `qsps` for text format. File reading/writing was deliberately not made a part of library so it can easily be used in any environment (browser or Node.js) that supports ArrayBuffer and typed arrays. 
Text format is expecting `utf8` encoded string so if you have string in different encoding you need to convert it before using library.

### Reading

```typescript
function readQsp(buffer: ArrayBuffer): QspLocation[];
function readQsps(content: string): QspLocation[];
```

### Writing 

```typescript
function function writeQsp(locations: QspLocation[]): ArrayBuffer;
function function writeQsps(locations: QspLocation[], linebreak?: string): string;
```

`writeQsps` uses `\n` as line-break by default but this can be configured using second argument.

## Licensing

The code in this project is licensed under MIT license.
