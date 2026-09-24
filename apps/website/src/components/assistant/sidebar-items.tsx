import { chatExamples } from "./examples";
import { SidebarItem } from "./sidebar-item";

interface SidebarItemsProps {
  onSelect: (id: string) => void;
  chatId?: string;
}

const formatRange = (key: string) => {
  switch (key) {
    case "1d":
      return "Today";
    case "2d":
      return "Yesterday";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    default:
      return null;
  }
};

type SidebarSection = "1d" | "2d" | "7d" | "30d";
type SidebarEntry = { id: string; title: string };

const titleAt = (index: number) => chatExamples[index]?.title ?? "";

const items: Record<SidebarSection, SidebarEntry[]> = {
  "1d": [
    {
      id: "1",
      title: titleAt(0),
    },
    {
      id: "2",
      title: titleAt(2),
    },
  ],
  "2d": [
    {
      id: "1",
      title: titleAt(3),
    },
    {
      id: "2",
      title: titleAt(4),
    },
  ],
  "7d": [
    {
      id: "1",
      title: titleAt(5),
    },
    {
      id: "2",
      title: titleAt(6),
    },
    {
      id: "3",
      title: titleAt(0),
    },
    {
      id: "4",
      title: titleAt(2),
    },
    {
      id: "5",
      title: titleAt(3),
    },
  ],
  "30d": [
    {
      id: "1",
      title: titleAt(2),
    },
    {
      id: "2",
      title: titleAt(3),
    },
    {
      id: "3",
      title: titleAt(4),
    },
    {
      id: "4",
      title: titleAt(5),
    },
    {
      id: "5",
      title: titleAt(6),
    },
  ],
};

const sections = Object.keys(items) as SidebarSection[];

export function SidebarItems({ onSelect }: SidebarItemsProps) {
  return (
    <div className="overflow-auto relative h-full md:h-[410px] mt-4 scrollbar-hide p-4 pt-0 pb-[70px] flex flex-col space-y-6">
      {!sections.length && (
        <div className="flex flex-col justify-center items-center h-full">
          <div className="flex flex-col items-center -mt-12 text-xs space-y-1">
            <span className="text-[#878787]">History</span>
            <span>No results found</span>
          </div>
        </div>
      )}

      {sections.map((key) => {
        const section = items[key];

        return (
          <div key={key}>
            {section?.length > 0 && (
              <div className="sticky top-0 z-20 w-full bg-background dark:bg-[#131313] pb-1">
                <span className="font-mono text-xs">{formatRange(key)}</span>
              </div>
            )}

            <div className="mt-1">
              {section?.map((chat) => {
                return (
                  <SidebarItem key={chat.id} chat={chat} onSelect={onSelect} />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
