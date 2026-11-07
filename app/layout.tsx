import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Movie Night',
  description: 'Watch movies together, far apart.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
