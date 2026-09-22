import { z } from "zod";

export const processAttachmentSchema = z.object({
  teamId: z.string().uuid(),
  mimetype: z.string(),
  size: z.number(),
  filePath: z.array(z.string()),
  referenceId: z.string().optional(),
  website: z.string().optional(),
  inboxAccountId: z.string().uuid().optional(),
});

export type ProcessAttachmentPayload = z.infer<typeof processAttachmentSchema>;

export const initialInboxSetupSchema = z.object({
  id: z.string().uuid(),
});

export type InitialInboxSetupPayload = z.infer<typeof initialInboxSetupSchema>;

export const inviteTeamMembersSchema = z.object({
  teamId: z.string().uuid(),
  ip: z.string(),
  locale: z.string(),
  invites: z.array(
    z.object({
      email: z.string().email(),
      invitedByName: z.string(),
      invitedByEmail: z.string().email(),
      teamName: z.string(),
    }),
  ),
});

export type InviteTeamMembersPayload = z.infer<typeof inviteTeamMembersSchema>;

export const onboardTeamSchema = z.object({
  userId: z.string().uuid(),
});

export type OnboardTeamPayload = z.infer<typeof onboardTeamSchema>;
