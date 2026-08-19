const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((pattern) => command.includes(pattern));
}
