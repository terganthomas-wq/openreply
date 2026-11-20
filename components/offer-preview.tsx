"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Offer Preview
 *
 * An offer's DM thread on the campaign preview's phone: the offer messages
 * with the pauses before them, the button and a tap on it, the
 * confirmations, the card, and the reminder that goes out instead when
 * nobody taps. The thread scrolls inside the phone, which is shorter than a
 * whole offer.
 */

import {
  Avatar,
  DmComposer,
  DmHeader,
  Phone,
  SAMPLE_USER,
  StatusBar,
  THREAD_SCROLLBAR,
} from "@/components/campaign-preview";
import { useI18n } from "@/lib/i18n/provider";
import type { TimedMessage } from "@/lib/offers/editor";
import { CARD_DELAY_MS } from "@/lib/offers/schedule";
import { renderMessageWithoutLink } from "@/lib/tracking/message";

interface OfferPreviewProps {
  username: string;
  avatarUrl: string | null;
  /** The messages that go out (blank rows already left out). */
  offerMessages: TimedMessage[];
  offerButtonLabel: string;
  confirmationMessages: TimedMessage[];
  /** Null shows the image placeholder: none set, or it does not load. */
  cardImageUrl: string | null;
  cardTitle: string;
  cardSubtitle: string;
  cardButtonLabel: string;
  reminderEnabled: boolean;
  reminderDelayHours: number;
  reminderMessage: string;
}

// As the worker sends it: {username} becomes the person's name, {link} goes
// (the link travels on the buttons).
function render(text: string) {
  return renderMessageWithoutLink({ message: text, commenterName: SAMPLE_USER });
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-center text-[11px] text-zinc-500">{children}</p>;
}

function Pause({ seconds }: { seconds: number }) {
  const { t } = useI18n();
  if (seconds <= 0) return null;
  return <Note>{t("{seconds} s later", { seconds })}</Note>;
}

function ButtonRow({ label }: { label: string }) {
  return (
    <div className="mx-1.5 mb-1.5 break-words rounded-xl bg-zinc-700 px-4 py-1.5 text-center text-sm font-medium text-white">
      {label}
    </div>
  );
}

function BotBubble({
  avatarUrl,
  text,
  button,
}: {
  avatarUrl: string | null;
  text: string;
  button?: string;
}) {
  return (
    <div className="flex items-end gap-2">
      <Avatar url={avatarUrl} size={24} />
      <div className="max-w-[80%] overflow-hidden rounded-2xl rounded-bl-md bg-zinc-800">
        <p className="whitespace-pre-wrap break-words px-3 py-2 text-sm">{text}</p>
        {button !== undefined && <ButtonRow label={button} />}
      </div>
    </div>
  );
}

function TapBubble({ label }: { label: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] break-words rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm">
        {label}
      </div>
    </div>
  );
}

export default function OfferPreview(props: OfferPreviewProps) {
  const { t } = useI18n();
  const { avatarUrl } = props;
  // The form always has one offer message; an empty one shows its hint.
  const messages =
    props.offerMessages.length > 0
      ? props.offerMessages
      : [{ text: "", delaySeconds: 0 }];
  const offerButton = props.offerButtonLabel.trim() || t("Button label");
  const cardButton = props.cardButtonLabel.trim() || t("Button label");

  return (
    <Phone>
      <div className="flex h-full flex-col text-white">
        <StatusBar />
        <DmHeader username={props.username} avatarUrl={avatarUrl} />

        <div
          className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 ${THREAD_SCROLLBAR}`}
        >
          <Note>{t("After the campaign's link")}</Note>

          {messages.map((message, i) => (
            <div key={i} className="space-y-3">
              <Pause seconds={message.delaySeconds} />
              <BotBubble
                avatarUrl={avatarUrl}
                text={message.text ? render(message.text) : t("Write a message")}
                // The last one carries the button.
                button={i === messages.length - 1 ? offerButton : undefined}
              />
            </div>
          ))}
          <TapBubble label={offerButton} />

          {props.confirmationMessages.map((message, i) => (
            <div key={i} className="space-y-3">
              <Pause seconds={message.delaySeconds} />
              <BotBubble avatarUrl={avatarUrl} text={render(message.text)} />
            </div>
          ))}

          <Pause seconds={CARD_DELAY_MS / 1000} />
          <div className="flex items-end gap-2">
            <Avatar url={avatarUrl} size={24} />
            <div className="w-[75%] overflow-hidden rounded-2xl rounded-bl-md bg-zinc-800">
              {props.cardImageUrl ? (
                <img
                  src={props.cardImageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <div className="grid aspect-square w-full place-items-center bg-zinc-700 text-xs text-zinc-400">
                  {t("No image")}
                </div>
              )}
              <div className="space-y-0.5 px-3 py-2">
                <p className="break-words text-sm font-semibold">
                  {props.cardTitle.trim() || t("Card title")}
                </p>
                {props.cardSubtitle.trim() && (
                  <p className="break-words text-xs text-zinc-400">
                    {props.cardSubtitle.trim()}
                  </p>
                )}
              </div>
              <ButtonRow label={cardButton} />
            </div>
          </div>

          {props.reminderEnabled && (
            <>
              <Note>
                {t("{hours} h later if they don't tap", {
                  hours: props.reminderDelayHours,
                })}
              </Note>
              <BotBubble
                avatarUrl={avatarUrl}
                text={
                  props.reminderMessage.trim()
                    ? render(props.reminderMessage)
                    : t("Write a message")
                }
                button={cardButton}
              />
            </>
          )}
        </div>

        <DmComposer />
      </div>
    </Phone>
  );
}
