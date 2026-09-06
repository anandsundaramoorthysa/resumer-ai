/**
 * ATS-safe PDF renderer — REQ-6.1, REQ-6.3.
 *
 * Text nodes only. No <Image>, no tables, no columns, no icons — which also guarantees
 * the embedded-text-layer requirement by construction: there is no path here that
 * produces a rasterized page.
 *
 * Helvetica is react-pdf's built-in metric-compatible stand-in for Arial; using a
 * built-in font avoids an embedded-subset failure mode where a parser can't decode
 * glyphs it has no mapping for.
 */

import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Link,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { ResumeDocument } from '../types';
import { coerceHeading } from './headings';

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
  name: { fontSize: 18, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  contactLine: { fontSize: 9.5, marginBottom: 2 },
  sectionHeading: {
    fontSize: 11.5,
    fontFamily: 'Helvetica-Bold',
    marginTop: 14,
    marginBottom: 5,
    borderBottomWidth: 0.75,
    borderBottomColor: '#000000',
    paddingBottom: 2,
  },
  groupTitleRow: { marginTop: 7 },
  groupTitle: { fontSize: 10.5, fontFamily: 'Helvetica-Bold' },
  groupSubtitle: { fontSize: 10 },
  groupDates: { fontSize: 9.5 },
  bulletRow: { flexDirection: 'row', marginTop: 2.5, paddingRight: 4 },
  bulletMark: { width: 10 },
  bulletText: { flex: 1 },
  plainItem: { marginTop: 2.5 },
});

function ContactBlock({ doc }: { doc: ResumeDocument }) {
  const c = doc.contact;
  // Plain labelled text in the document body — never a header/footer, never an icon.
  const line1 = [c.email, c.phone, c.location].filter(Boolean).join('  |  ');
  const links = [c.portfolioUrl, c.githubUrl, c.linkedinUrl].filter(Boolean) as string[];

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

function ResumePdf({ doc }: { doc: ResumeDocument }) {
  return (
    <Document
      title={`${doc.contact.fullName} — Resume`}
      author={doc.contact.fullName}
      creator="Resumer AI"
      producer="Resumer AI"
    >
      <Page size="A4" style={styles.page}>
        <ContactBlock doc={doc} />

        {doc.sections.map((section) => (
          <View key={section.key} wrap={false}>
            <Text style={styles.sectionHeading}>
              {coerceHeading(section.key, section.heading).toUpperCase()}
            </Text>

            {section.items.map((item, i) =>
              section.key === 'skills' ? (
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
                {group.items.map((item, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <Text style={styles.bulletMark}>•</Text>
                    <Text style={styles.bulletText}>{item.text}</Text>
                  </View>
                ))}
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

function ensureProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
