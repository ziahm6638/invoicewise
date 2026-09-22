import { ThemeSwitch } from "@/components/theme-switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";

export function ChangeTheme() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Customize how InvoiceWise looks on your device.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="w-[240px]">
          <ThemeSwitch />
        </div>
      </CardContent>
    </Card>
  );
}
