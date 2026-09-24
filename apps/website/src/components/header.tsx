"use client";

import { cn } from "@invoicewise/ui/cn";
import { motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Wordmark } from "./brand";

const listVariant = {
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 },
  },
  hidden: { opacity: 0 },
};

const itemVariant = {
  hidden: { opacity: 0 },
  show: { opacity: 1 },
};

const links = [
  { title: "How it works", path: "/#how-it-works" },
  { title: "Pricing", path: "/pricing" },
];

export function Header() {
  const pathname = usePathname();
  const [isOpen, setOpen] = useState(false);

  useEffect(() => {
    const setPixelRatio = () => {
      const pixelRatio = window.devicePixelRatio || 1;
      document.documentElement.style.setProperty(
        "--pixel-ratio",
        `${1 / pixelRatio}`,
      );
    };

    setPixelRatio();
    window.addEventListener("resize", setPixelRatio);
    return () => window.removeEventListener("resize", setPixelRatio);
  }, []);

  const handleToggleMenu = () => {
    setOpen((prev) => {
      document.body.style.overflow = prev ? "" : "hidden";
      return !prev;
    });
  };

  return (
    <header className="sticky mt-4 top-4 z-50 px-2 md:px-4 md:flex justify-center">
      <nav className="border border-border px-4 flex items-center backdrop-filter backdrop-blur-xl bg-[#FFFFFF] dark:bg-[#121212] bg-opacity-70 h-[50px] z-20 relative">
        <Link href="/" className="flex items-center">
          <span className="sr-only">InvoiceWise</span>
          <Wordmark />
        </Link>

        <ul className="space-x-2 font-medium text-sm hidden md:flex mx-3">
          {links.map(({ path, title }) => (
            <li key={path}>
              <Link
                href={path}
                className="h-8 items-center justify-center text-sm font-medium px-3 py-2 inline-flex text-secondary-foreground transition-opacity hover:opacity-70 duration-200"
              >
                {title}
              </Link>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="ml-auto md:hidden p-2"
          onClick={handleToggleMenu}
        >
          <span className="sr-only">Open menu</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={18}
            height={13}
            fill="none"
          >
            <path
              fill="currentColor"
              d="M0 12.195v-2.007h18v2.007H0Zm0-5.017V5.172h18v2.006H0Zm0-5.016V.155h18v2.007H0Z"
            />
          </svg>
        </button>

        <a
          className="text-sm font-medium pr-2 border-l-[1px] border-border pl-4 hidden md:block"
          href="https://app.invoicewise.uk"
        >
          Sign in
        </a>
      </nav>

      {isOpen && (
        <motion.div
          className="fixed bg-background -top-[2px] right-0 left-0 bottom-0 h-screen z-10 px-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <div className="mt-4 flex justify-between p-3 px-4 relative ml-[1px]">
            <Link href="/" onClick={handleToggleMenu}>
              <Wordmark />
            </Link>

            <button
              type="button"
              className="ml-auto p-2 absolute right-[10px] top-2"
              onClick={handleToggleMenu}
            >
              <span className="sr-only">Close menu</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={24}
                height={24}
                className="fill-primary"
              >
                <path fill="none" d="M0 0h24v24H0V0z" />
                <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
              </svg>
            </button>
          </div>

          <div className="h-screen pb-[150px] overflow-auto">
            <motion.ul
              initial="hidden"
              animate="show"
              className="px-3 pt-8 text-xl text-[#878787] space-y-8 mb-8 overflow-auto"
              variants={listVariant}
            >
              {links.map(({ path }) => (
                <motion.li variants={itemVariant} key={path}>
                  <Link
                    href={path}
                    className={cn(pathname === path && "text-primary")}
                    onClick={handleToggleMenu}
                  >
                    {path === "/pricing" ? "Pricing" : "How it works"}
                  </Link>
                </motion.li>
              ))}

              <motion.li
                className="mt-auto border-t-[1px] pt-8"
                variants={itemVariant}
              >
                <a
                  className="text-xl text-primary"
                  href="https://app.invoicewise.uk"
                >
                  Sign in
                </a>
              </motion.li>
            </motion.ul>
          </div>
        </motion.div>
      )}
    </header>
  );
}
