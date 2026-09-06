import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * These are loaded from node_modules at runtime rather than bundled.
   *
   * pdf-parse/pdfjs-dist resolve a worker file by path at runtime, which a bundler
   * rewrites out from under them; @react-pdf and docx are heavy Node-only renderers
   * with their own asset/font resolution. Keeping all four external is what makes the
   * round-trip self-test (REQ-6.6) work in a built app rather than only in dev.
   */
  serverExternalPackages: [
    'pdf-parse',
    'pdfjs-dist',
    '@react-pdf/renderer',
    'docx',
    'mammoth',
  ],
};

export default nextConfig;
