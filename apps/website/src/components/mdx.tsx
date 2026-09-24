import { MDXRemote } from "next-mdx-remote/rsc";
import Image from "next/image";
import Link from "next/link";
import React from "react";
import { generate, tokenize } from "sugar-high";

interface TableProps {
  data: {
    headers: string[];
    rows: string[][];
  };
}

function Table({ data }: TableProps) {
  const headers = data.headers.map((header) => <th key={header}>{header}</th>);

  const rows = data.rows.map((row) => {
    const seen = new Map<string, number>();
    const cells = row.map((cell) => {
      const occurrence = seen.get(cell) ?? 0;
      seen.set(cell, occurrence + 1);
      return (
        <td key={occurrence === 0 ? cell : `${cell}-${occurrence}`}>{cell}</td>
      );
    });
    return <tr key={row.join("-")}>{cells}</tr>;
  });

  return (
    <table>
      <thead>
        <tr>{headers}</tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

interface CustomLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

function CustomLink({ href, ...props }: CustomLinkProps) {
  if (href.startsWith("/")) {
    return (
      <Link href={href} {...props}>
        {props.children}
      </Link>
    );
  }

  if (href.startsWith("#")) {
    return <a href={href} {...props} />;
  }

  return <a href={href} target="_blank" rel="noopener noreferrer" {...props} />;
}

interface RoundedImageProps extends React.ComponentProps<typeof Image> {
  alt: string;
}

function RoundedImage(props: RoundedImageProps) {
  return <Image {...props} />;
}

interface CodeProps {
  children: string;
}

type HastNode = {
  type: "text" | "element";
  tagName?: string;
  properties?: { className?: string };
  children?: HastNode[];
  value?: string;
};

/**
 * Renders the sugar-high token tree as React elements. This keeps highlighted
 * code out of `dangerouslySetInnerHTML`, so no HTML string is ever injected
 * into the document.
 */
function renderTokens(nodes: HastNode[], counter: { value: number }) {
  return nodes.map((node): React.ReactNode => {
    counter.value += 1;
    const key = `sh-${counter.value}`;
    if (node.type === "text") {
      return node.value ?? "";
    }
    return (
      <span key={key} className={node.properties?.className}>
        {renderTokens(node.children ?? [], counter)}
      </span>
    );
  });
}

function Code({ children, ...props }: CodeProps) {
  const nodes = generate(tokenize(children)) as HastNode[];
  return <code {...props}>{renderTokens(nodes, { value: 0 })}</code>;
}

function slugify(str: string): string {
  return str
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/&/g, "-and-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");
}

function createHeading(level: number) {
  const Heading = ({ children }: { children: React.ReactNode }) => {
    const slug = slugify(children as string);

    return React.createElement(
      `h${level}`,
      { id: slug },
      [
        React.createElement("a", {
          href: `#${slug}`,
          key: `link-${slug}`,
          className: "anchor",
        }),
      ],
      children,
    );
  };

  Heading.displayName = `Heading${level}`;

  return Heading;
}

interface IframeProps extends React.IframeHTMLAttributes<HTMLIFrameElement> {
  src: string;
}

function Iframe({ src, ...props }: IframeProps) {
  return <iframe src={src} {...props} />;
}

const components = {
  h1: createHeading(1),
  h2: createHeading(2),
  h3: createHeading(3),
  h4: createHeading(4),
  h5: createHeading(5),
  h6: createHeading(6),
  Image: RoundedImage,
  a: CustomLink,
  code: Code,
  Table,
  iframe: Iframe,
};

interface CustomMDXProps {
  source: string;
  components?: Record<string, React.ComponentType<unknown>>;
}

export function CustomMDX({ source, components: overrides }: CustomMDXProps) {
  return (
    <MDXRemote
      source={source}
      components={{ ...components, ...(overrides ?? {}) }}
    />
  );
}
