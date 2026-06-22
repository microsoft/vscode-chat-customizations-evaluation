import * as vscode from 'vscode';

export class UrlResolver {
  private isUriLike(value: unknown): value is vscode.Uri {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as {
      scheme?: unknown;
      path?: unknown;
      toString?: unknown;
    };

    return (
      typeof candidate.scheme === 'string'
      && typeof candidate.path === 'string'
      && typeof candidate.toString === 'function'
    );
  }

  toUri(value: unknown): vscode.Uri | undefined {
    if (!value) {
      return undefined;
    }

    if (this.isUriLike(value)) {
      return value;
    }

    if (typeof value === 'string') {
      try {
        return vscode.Uri.parse(value);
      } catch {
        return undefined;
      }
    }

    if (typeof value === 'object') {
      const candidate = value as {
        scheme?: unknown;
        path?: unknown;
        authority?: unknown;
        query?: unknown;
        fragment?: unknown;
      };
      if (typeof candidate.scheme === 'string' && typeof candidate.path === 'string') {
        return vscode.Uri.from({
          scheme: candidate.scheme,
          path: candidate.path,
          authority: typeof candidate.authority === 'string' ? candidate.authority : '',
          query: typeof candidate.query === 'string' ? candidate.query : '',
          fragment: typeof candidate.fragment === 'string' ? candidate.fragment : '',
        });
      }
    }

    return undefined;
  }

  getCustomizationUri(obj: unknown): vscode.Uri | undefined {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    const arg = obj as {
      uri?: unknown;
      resourceUri?: unknown;
      item?: {
        uri?: unknown;
        resourceUri?: unknown;
      };
    };

    return (
      this.toUri(arg.uri)
      ?? this.toUri(arg.resourceUri)
      ?? this.toUri(arg.item?.uri)
      ?? this.toUri(arg.item?.resourceUri)
    );
  }
}