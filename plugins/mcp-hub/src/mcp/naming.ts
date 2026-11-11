export const MAX_NAME_LENGTH = 48;

export interface NameResolution {
  registeredName: string;
  renamedFrom?: string;
}

function sanitizeName(name: string): string {
  // Replace characters outside [a-zA-Z0-9_-] with _
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Collapse runs of _
  sanitized = sanitized.replace(/_+/g, '_');

  // Trim leading and trailing _
  sanitized = sanitized.replace(/^_+|_+$/g, '');

  return sanitized;
}

function truncateName(
  name: string,
  maxLen: number = MAX_NAME_LENGTH
): string {
  if (name.length <= maxLen) {
    return name;
  }

  // Truncate to maxLen and clean up any trailing underscores
  let truncated = name.substring(0, maxLen);
  truncated = truncated.replace(/_+$/, '');

  return truncated;
}

function isValidName(name: string): boolean {
  // A valid name must be non-empty and contain at least one alphanumeric or dash
  return name.length > 0 && /[a-zA-Z0-9-]/.test(name);
}

function isReserved(name: string): boolean {
  return name === "update_environment_directory";
}

export function resolveName(args: {
  serverId: string;
  upstreamName: string;
  taken: ReadonlySet<string>;
}): NameResolution {
  // Step 1: Sanitize and truncate the upstream name
  let candidate = sanitizeName(args.upstreamName);
  candidate = truncateName(candidate);

  // Step 2: If valid, not taken, and not reserved, return it
  if (isValidName(candidate) && !args.taken.has(candidate) && !isReserved(candidate)) {
    return { registeredName: candidate };
  }

  // Step 3: Prefix with sanitized serverId
  const prefix = sanitizeName(args.serverId);
  let prefixed = `${prefix}_${candidate}`;
  prefixed = truncateName(prefixed);

  // Step 4: Try the prefixed name if valid, not taken, and not reserved
  if (isValidName(prefixed) && !args.taken.has(prefixed) && !isReserved(prefixed)) {
    return { registeredName: prefixed, renamedFrom: args.upstreamName };
  }

  // Step 5: Try adding suffixes, truncating base as needed to fit within budget
  for (let suffix = 2; suffix < 1000; suffix++) {
    const suffixStr = `_${suffix}`;
    const maxBaseLen = MAX_NAME_LENGTH - suffixStr.length;

    let baseName = prefixed;
    if (baseName.length > maxBaseLen) {
      baseName = baseName.substring(0, maxBaseLen);
      baseName = baseName.replace(/_+$/, '');
    }

    const candidateName = `${baseName}${suffixStr}`;

    // Verify the result is valid, within budget, not taken, and not reserved
    if (isValidName(candidateName) &&
        candidateName.length <= MAX_NAME_LENGTH &&
        !args.taken.has(candidateName) &&
        !isReserved(candidateName)) {
      return { registeredName: candidateName, renamedFrom: args.upstreamName };
    }
  }

  // Should never reach here in practice
  throw new Error(`Could not resolve name for ${args.upstreamName}`);
}
