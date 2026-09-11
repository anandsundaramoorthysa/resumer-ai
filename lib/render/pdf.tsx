/**
 * PDF renderer — REQ-6.1, REQ-6.2, REQ-6.3.
 *
 * Two modes off one document model:
 *
 *   ats-strict (default)  Text nodes only. No <Image>, no tables, no columns, no icons —
 *                         which also guarantees the embedded-text-layer requirement by
 *                         construction, since no path here can produce a rasterized page.
 *
 *   presentation          The same document with small vector icons beside the contact
 *                         fields, for a human reader rather than a parser (REQ-6.2).
 *
 * Helvetica is react-pdf's built-in metric-compatible stand-in for Arial; using a
 * built-in font avoids an embedded-subset failure mode where a parser can't decode
 * glyphs it has no mapping for.
 */

import React from 'react';
import {
  Circle,
  Document,
  Font,
  Page,
  Path,
  Svg,
  Text,
  View,
  StyleSheet,
  Link,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { ResumeDocument } from '../types';

/**
 * Never break a word across lines.
 *
 * @react-pdf hyphenates by default, and the hyphen it inserts survives text extraction —
 * which is the one thing this document must not do. Round-tripping a generated resume
 * through a parser produced "produc-tion-grade", "bench-marked" and "resolu-tions": an
 * ATS scanning for "production-grade" finds neither half, and the keyword the whole
 * pipeline optimised for is silently lost at the last step.
 *
 * The callback returns the word as a single part, which is how @react-pdf is told a word
 * has no break points. The cost is slightly looser right margins on narrow columns —
 * a fair trade against losing keywords, and invisible next to what it prevents.
 */
Font.registerHyphenationCallback((word) => [word]);
import { coerceHeading } from './headings';
import { rendersAsPlainLine } from './sections';

/**
 * Presentation mode's single accent, taken from the app's own palette (brand-dark).
 * Measured 7.38:1 on white — well above the 4.5:1 needed for normal text, so the
 * coloured name and rule stay readable rather than merely decorative, and the file still
 * prints legibly in greyscale.
 */
const ACCENT_COLOR = '#0a5f67';

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 48,
    fontFamily: 'Helvetica',
    fontSize: 10.5,
    lineHeight: 1.4,
    color: '#000000',
  },
  name: { fontSize: 18, fontFamily: 'Helvetica-Bold', marginBottom: 4, textAlign: 'center' },
  contactLine: { fontSize: 9.5, marginBottom: 2, textAlign: 'center' },
  sectionHeading: {
    fontSize: 11.5,
    fontFamily: 'Helvetica-Bold',
    marginTop: 14,
    marginBottom: 5,
    borderBottomWidth: 0.75,
    borderBottomColor: '#000000',
    paddingBottom: 2,
  },
  // Title left, dates right, on one line.
  groupTitleRow: { marginTop: 7, flexDirection: 'row', justifyContent: 'space-between' },
  groupTitle: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', flex: 1, paddingRight: 8 },
  // "Label:" in a fixed column, values beside it — wrapped lines stay aligned.
  skillRow: { flexDirection: 'row', marginTop: 2.5 },
  skillLabel: { width: 135, fontFamily: 'Helvetica-Bold' },
  skillValue: { flex: 1 },
  // The degree under an institution.
  eduLine: { fontFamily: 'Helvetica-Oblique', marginTop: 1, paddingLeft: 10 },
  groupSubtitle: { fontSize: 10 },
  groupDates: { fontSize: 9.5 },
  bulletRow: { flexDirection: 'row', marginTop: 2.5, paddingRight: 4 },
  bulletMark: { width: 10 },
  bulletText: { flex: 1 },
  plainItem: { marginTop: 2.5 },

  // --- presentation mode only ---------------------------------------------
  contactGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 3, justifyContent: 'center' },
  contactCell: { flexDirection: 'row', alignItems: 'center', marginRight: 14, marginTop: 3 },
  contactCellText: { fontSize: 9.5, marginLeft: 4 },
  accentRule: { marginTop: 8, borderBottomWidth: 1.5, borderBottomColor: ACCENT_COLOR },
});

/* ------------------------------------------------------- presentation icons -- */

/**
 * Contact icons, drawn as vector paths — REQ-6.2.
 *
 * These are <Path> geometry, not characters from an icon font, and that distinction is
 * the entire reason the requirement names it. An icon font renders as a blank box, or as
 * nothing at all, wherever the font isn't embedded or the reader substitutes it — and
 * because the glyph usually sits in the same run as the value beside it, the phone number
 * or the email address goes with it. Geometry has no such dependency: it is in the file.
 *
 * They exist in this file and nowhere else on purpose. There is no DOCX equivalent and
 * there must not be one (REQ-6.2 is PDF-only), so keeping them here keeps them
 * unreachable from the other renderer.
 */
const ICON_STROKE = { stroke: ACCENT_COLOR, strokeWidth: 1.8, fill: 'none' } as const;

function EmailIcon() {
  return (
    <Svg width={9} height={9} viewBox="0 0 24 24">
      <Path d="M3 6h18v12H3z" {...ICON_STROKE} />
      <Path d="m3 7 9 6 9-6" {...ICON_STROKE} />
    </Svg>
  );
}

function PhoneIcon() {
  return (
    <Svg width={9} height={9} viewBox="0 0 24 24">
      <Path
        d="M7 3h3l1.5 4.5-2.2 1.3a12 12 0 0 0 5.9 5.9l1.3-2.2L21 14v3a3 3 0 0 1-3 3A15 15 0 0 1 4 6a3 3 0 0 1 3-3z"
        {...ICON_STROKE}
      />
    </Svg>
  );
}

function LocationIcon() {
  return (
    <Svg width={9} height={9} viewBox="0 0 24 24">
      <Path d="M12 22s7-6.3 7-11.5a7 7 0 1 0-14 0C5 15.7 12 22 12 22z" {...ICON_STROKE} />
      <Circle cx={12} cy={10} r={2.6} {...ICON_STROKE} />
    </Svg>
  );
}

function GlobeIcon() {
  return (
    <Svg width={9} height={9} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9} {...ICON_STROKE} />
      <Path d="M3 12h18" {...ICON_STROKE} />
      <Path d="M12 3c2.6 3 3.9 6 3.9 9s-1.3 6-3.9 9c-2.6-3-3.9-6-3.9-9s1.3-6 3.9-9z" {...ICON_STROKE} />
    </Svg>
  );
}

function CodeIcon() {
  return (
    <Svg width={9} height={9} viewBox="0 0 24 24">
      <Path d="m8 7-5 5 5 5" {...ICON_STROKE} />
      <Path d="m16 7 5 5-5 5" {...ICON_STROKE} />
    </Svg>
  );
}

function PersonIcon() {
  return (
    <Svg width={9} height={9} viewBox="0 0 24 24">
      <Circle cx={12} cy={8} r={3.6} {...ICON_STROKE} />
      <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...ICON_STROKE} />
    </Svg>
  );
}

function ContactBlock({ doc }: { doc: ResumeDocument }) {
  const c = doc.contact;
  const links = [c.portfolioUrl, c.githubUrl, c.linkedinUrl].filter(Boolean) as string[];

  if (doc.renderMode === 'presentation') {
    return <PresentationContactBlock doc={doc} />;
  }

  // Plain labelled text in the document body — never a header/footer, never an icon.
  const line1 = [c.email, c.phone, c.location].filter(Boolean).join('  |  ');

  return (
    <View>
      <Text style={styles.name}>{c.fullName}</Text>
      {line1 ? <Text style={styles.contactLine}>{line1}</Text> : null}
      {links.length > 0 ? (
        <Text style={styles.contactLine}>
          {links.map((url, i) => (
            <React.Fragment key={url}>
              {i > 0 ? '  |  ' : ''}
              {/* Visible text IS the URL (REQ-6.1) — if a parser strips the link
                  metadata, the readable text still carries the full address. */}
              <Link src={ensureProtocol(url)} style={{ color: '#000000', textDecoration: 'none' }}>
                {stripProtocol(url)}
              </Link>
            </React.Fragment>
          ))}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The icons sit beside the values, never in place of them. Every field is still spelled
 * out as text, so this file loses nothing if it does end up in front of a parser — the
 * reason it is labelled unsuitable for a portal is the layout and the colour, not a
 * missing address.
 */
function PresentationContactBlock({ doc }: { doc: ResumeDocument }) {
  const c = doc.contact;

  const cells: Array<{ icon: React.ReactNode; text: string; href?: string }> = [];
  if (c.email) cells.push({ icon: <EmailIcon />, text: c.email });
  if (c.phone) cells.push({ icon: <PhoneIcon />, text: c.phone });
  if (c.location) cells.push({ icon: <LocationIcon />, text: c.location });
  if (c.portfolioUrl) {
    cells.push({ icon: <GlobeIcon />, text: stripProtocol(c.portfolioUrl), href: c.portfolioUrl });
  }
  if (c.githubUrl) {
    cells.push({ icon: <CodeIcon />, text: stripProtocol(c.githubUrl), href: c.githubUrl });
  }
  if (c.linkedinUrl) {
    cells.push({ icon: <PersonIcon />, text: stripProtocol(c.linkedinUrl), href: c.linkedinUrl });
  }

  return (
    <View>
      <Text style={[styles.name, { color: ACCENT_COLOR }]}>{c.fullName}</Text>
      <View style={styles.contactGrid}>
        {cells.map((cell) => (
          <View key={cell.text} style={styles.contactCell}>
            {cell.icon}
            {cell.href ? (
              <Link
                src={ensureProtocol(cell.href)}
                style={[styles.contactCellText, { color: '#000000', textDecoration: 'none' }]}
              >
                {cell.text}
              </Link>
            ) : (
              <Text style={styles.contactCellText}>{cell.text}</Text>
            )}
          </View>
        ))}
      </View>
      <View style={styles.accentRule} />
    </View>
  );
}

function ResumePdf({ doc }: { doc: ResumeDocument }) {
  const presentation = doc.renderMode === 'presentation';
  const headingStyle = presentation
    ? [styles.sectionHeading, { color: ACCENT_COLOR, borderBottomColor: ACCENT_COLOR }]
    : styles.sectionHeading;

  return (
    <Document
      title={`${doc.contact.fullName} — Resume${presentation ? ' (presentation)' : ''}`}
      author={doc.contact.fullName}
      creator="Resumer AI"
      producer="Resumer AI"
    >
      <Page size="A4" style={styles.page}>
        <ContactBlock doc={doc} />

        {doc.sections.map((section) => (
          <View key={section.key} wrap={false}>
            {/* The heading is coerced to the allow-list in both modes. Presentation mode
                relaxes the visual rules, never the vocabulary — a heading a parser can't
                place is a bad heading whoever is reading it. */}
            <Text style={headingStyle}>
              {coerceHeading(section.key, section.heading).toUpperCase()}
            </Text>

            {section.items.map((item, i) =>
              section.key === 'skills' && item.text.includes(': ') ? (
                <View key={i} style={styles.skillRow}>
                  <Text style={styles.skillLabel}>{item.text.slice(0, item.text.indexOf(': ') + 1)}</Text>
                  <Text style={styles.skillValue}>{item.text.slice(item.text.indexOf(': ') + 2)}</Text>
                </View>
              ) : rendersAsPlainLine(section.key) ? (
                <Text key={i} style={styles.plainItem}>
                  {item.text}
                </Text>
              ) : (
                <View key={i} style={styles.bulletRow}>
                  <Text style={styles.bulletMark}>•</Text>
                  <Text style={styles.bulletText}>{item.text}</Text>
                </View>
              ),
            )}

            {(section.groups ?? []).map((group, gi) => (
              <View key={gi}>
                <View style={styles.groupTitleRow}>
                  <Text style={styles.groupTitle}>
                    {group.title}
                    {group.subtitle ? (
                      <Text style={styles.groupSubtitle}> — {group.subtitle}</Text>
                    ) : null}
                  </Text>
                  {group.dateRange ? (
                    <Text style={styles.groupDates}>{group.dateRange}</Text>
                  ) : null}
                </View>
                {group.items.map((item, i) =>
                  section.key === 'education' ? (
                    <Text key={i} style={styles.eduLine}>{item.text}</Text>
                  ) : (
                    <View key={i} style={styles.bulletRow}>
                      <Text style={styles.bulletMark}>•</Text>
                      <Text style={styles.bulletText}>{item.text}</Text>
                    </View>
                  ),
                )}
              </View>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderResumePdf(doc: ResumeDocument): Promise<Buffer> {
  return renderToBuffer(<ResumePdf doc={doc} />);
}

/**
 * Renders the same document as a presentation-mode PDF — REQ-6.2.
 *
 * A separate entry point rather than a flag on the stored document: a snapshot is what
 * was actually submitted somewhere (REQ-9.2), and switching its renderMode to produce a
 * nicer-looking copy would rewrite that record. This takes a copy instead.
 */
export async function renderPresentationPdf(doc: ResumeDocument): Promise<Buffer> {
  return renderResumePdf({ ...doc, renderMode: 'presentation' });
}

function ensureProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
