export interface PaddleOcrTextBox {
  text?: string;
  score?: number;
  confidence?: number;
  box?: number[][] | PaddleOcrRect;
  bbox?: number[][] | PaddleOcrRect;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface PaddleOcrRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface PaddleOcrRawResult {
  text?: string;
  boxes?: PaddleOcrTextBox[];
  results?: PaddleOcrTextBox[];
  result?: PaddleOcrTextBox[];
  lines?: PaddleOcrTextBox[] | PaddleOcrTextBox[][];
}

export interface NormalizedOcrText {
  text: string;
  position?: string;
  confidence?: number;
}

export interface NormalizedOcrResult {
  texts: NormalizedOcrText[];
  language: string;
}
