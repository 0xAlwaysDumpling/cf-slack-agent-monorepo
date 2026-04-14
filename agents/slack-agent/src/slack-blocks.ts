/**
 * Convert markdown text to Slack Block Kit format for rich message rendering.
 * Supports: headers, bold, code blocks, lists, dividers, links.
 */

export interface SlackBlock {
  type: string;
  [key: string]: any;
}

export function markdownToSlackBlocks(markdown: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const lines = markdown.split('\n');
  let currentSection = '';
  let inCodeBlock = false;
  let codeBlockContent = '';
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle code blocks
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        // Start code block
        if (currentSection) {
          blocks.push(createSectionBlock(currentSection));
          currentSection = '';
        }
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
      } else {
        // End code block
        inCodeBlock = false;
        blocks.push(createCodeBlock(codeBlockContent, codeBlockLang));
        codeBlockContent = '';
        codeBlockLang = '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += (codeBlockContent ? '\n' : '') + line;
      continue;
    }

    // Handle headers
    if (trimmed.startsWith('# ')) {
      if (currentSection) {
        blocks.push(createSectionBlock(currentSection));
        currentSection = '';
      }
      blocks.push(createHeaderBlock(trimmed.slice(2)));
      continue;
    }

    if (trimmed.startsWith('## ')) {
      if (currentSection) {
        blocks.push(createSectionBlock(currentSection));
        currentSection = '';
      }
      blocks.push(createSubheaderBlock(trimmed.slice(3)));
      continue;
    }

    // Handle dividers
    if (trimmed === '---' || trimmed === '***') {
      if (currentSection) {
        blocks.push(createSectionBlock(currentSection));
        currentSection = '';
      }
      blocks.push({ type: 'divider' });
      continue;
    }

    // Handle bullet/numbered lists
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
      if (currentSection && !currentSection.endsWith('\n')) {
        currentSection += '\n';
      }
      currentSection += (trimmed.startsWith('- ') || trimmed.startsWith('* '))
        ? '• ' + trimmed.slice(2)
        : trimmed;
      currentSection += '\n';
      continue;
    }

    // Empty line
    if (!trimmed) {
      if (currentSection) {
        blocks.push(createSectionBlock(currentSection));
        currentSection = '';
      }
      continue;
    }

    // Regular text
    currentSection += (currentSection && !currentSection.endsWith('\n') ? '\n' : '') + line;
  }

  // Flush any remaining content
  if (currentSection) {
    blocks.push(createSectionBlock(currentSection));
  }

  // If no blocks were created, create a default section
  if (blocks.length === 0 && markdown.trim()) {
    blocks.push(createSectionBlock(markdown));
  }

  return blocks;
}

function createHeaderBlock(text: string): SlackBlock {
  return {
    type: 'header',
    text: {
      type: 'plain_text',
      text: text.slice(0, 150), // Slack limit
      emoji: true,
    },
  };
}

function createSubheaderBlock(text: string): SlackBlock {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${text}*`,
    },
  };
}

function createSectionBlock(text: string): SlackBlock {
  // Convert markdown formatting to mrkdwn
  let mrkdwnText = text
    .replace(/\*\*(.*?)\*\*/g, '*$1*') // Bold
    .replace(/`(.*?)`/g, '`$1`') // Inline code
    .replace(/\[(.*?)\]\((.*?)\)/g, '<$2|$1>'); // Links

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: mrkdwnText.slice(0, 3000), // Slack limit
    },
  };
}

function createCodeBlock(code: string, language: string = ''): SlackBlock {
  // Wrap in markdown code fence for display
  const formattedCode = '```' + language + '\n' + code + '\n```';
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: formattedCode.slice(0, 3000),
    },
  };
}

export function createContextBlock(text: string): SlackBlock {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text,
      },
    ],
  };
}
