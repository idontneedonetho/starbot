export interface WikiPage {
  title: string;
  content: string;
  path: string;
  url: string;
}

export interface WikiResult {
  title: string;
  url: string;
  score: number;
}
